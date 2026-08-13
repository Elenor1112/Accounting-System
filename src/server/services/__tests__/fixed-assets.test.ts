/**
 * Fixed assets and depreciation.
 *
 * The audit's finding: assets stayed at cost indefinitely, so assets and
 * profit were both overstated and the misstatement grew every month. These
 * tests check the schedule arithmetic, the ledger effect of a run, the
 * idempotence that stops a re-run doubling the charge, and disposal.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { closeDb } from '@/db';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import {
  createAsset,
  disposeAsset,
  getAsset,
  getAssetRegister,
  getDepreciationSchedule,
  monthEnd,
  runDepreciation,
} from '@/server/services/fixed-asset-service';
import { getAccountBalance } from '@/server/services/journal-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('fixed assets and depreciation', () => {
  let co: TestCompany;

  const year = new Date().getUTCFullYear();
  const acquisitionDate = `${year}-01-15`;

  before(async () => {
    co = await createTestCompany({ permissions: ALL_PERMISSIONS });
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  const balanceOf = async (code: string) =>
    Number((await getAccountBalance(co.ctx, co.accountId(code))).balance);

  /**
   * 1210 Equipment, 1290 Accumulated Depreciation, 6800 Depreciation Expense.
   *
   * Accumulated depreciation is a *contra*-asset: it lives under `asset` so it
   * nets against cost on the balance sheet, which means `getAccountBalance`
   * signs it debit-normal and a credit balance reads negative. Negating here
   * lets the tests talk about the charge as a positive number, the way an
   * accountant would.
   */
  const accumulated = async () => -(await balanceOf('1290'));
  const expense = () => balanceOf('6800');

  test('month end is derived correctly, including February', () => {
    assert.equal(monthEnd('2026-01-15'), '2026-01-31');
    assert.equal(monthEnd('2026-04-02'), '2026-04-30');
    assert.equal(monthEnd('2027-02-10'), '2027-02-28');
    // Leap year, without a lookup table.
    assert.equal(monthEnd('2028-02-10'), '2028-02-29');
  });

  test('an asset is registered at cost with a useful life', async () => {
    const asset = await createAsset(co.ctx, {
      name: 'Delivery Van',
      category: 'Vehicles',
      acquisitionDate,
      cost: '60000',
      residualValue: '12000',
      usefulLifeMonths: 48,
    });

    assert.match(asset.assetNumber, /FA-/);
    assert.equal(asset.status, 'active');
    assert.equal(Number(asset.accumulatedDepreciation), 0);
    // 60,000 − 12,000 = 48,000 over 48 months = 1,000 a month.
  });

  test('an asset with residual above cost is refused', async () => {
    await assert.rejects(
      createAsset(co.ctx, {
        name: 'Impossible Asset',
        acquisitionDate,
        cost: '1000',
        residualValue: '5000',
        usefulLifeMonths: 12,
      }),
      /Residual value cannot exceed/,
    );
  });

  test('an asset with no useful life is refused', async () => {
    await assert.rejects(
      createAsset(co.ctx, {
        name: 'Perpetual Asset',
        acquisitionDate,
        cost: '1000',
        usefulLifeMonths: 0,
      }),
      /at least one month/,
    );
  });

  test('the schedule runs for the full life and lands on residual value', async () => {
    const register = await getAssetRegister(co.ctx);
    const van = register.assets.find((a) => a.name === 'Delivery Van')!;

    const schedule = await getDepreciationSchedule(co.ctx, van.id);

    assert.equal(schedule.length, 48, 'one row per month of useful life');
    assert.equal(Number(schedule[0]!.charge), 1000);
    assert.equal(Number(schedule[0]!.netBookValue), 59000);

    // The defining property: the asset finishes at exactly its residual value,
    // never a few cents either side of it.
    const last = schedule[schedule.length - 1]!;
    assert.equal(Number(last.accumulated), 48000);
    assert.equal(Number(last.netBookValue), 12000);
  });

  test('a depreciation run posts Dr Expense / Cr Accumulated Depreciation', async () => {
    const accumulatedBefore = await accumulated();
    const expenseBefore = await expense();

    const result = await runDepreciation(co.ctx, { periodEnd: `${year}-02-28` });

    assert.equal(result.assetsCharged, 1);
    assert.equal(Number(result.totalCharge), 1000);
    assert.ok(result.journalEntryId);

    assert.equal((await expense()) - expenseBefore, 1000);
    assert.equal((await accumulated()) - accumulatedBefore, 1000);
  });

  test('the register reflects the charge in net book value', async () => {
    const register = await getAssetRegister(co.ctx);
    const van = register.assets.find((a) => a.name === 'Delivery Van')!;

    assert.equal(Number(van.accumulatedDepreciation), 1000);
    assert.equal(Number(van.netBookValue), 59000);
    assert.equal(Number(register.totalNetBookValue), 59000);
  });

  test('re-running the same period charges nothing further', async () => {
    // The most likely way a depreciation engine misstates the accounts: an
    // accidental second run doubling the month. The unique index on
    // (assetId, periodEnd) makes it a no-op.
    const expenseBefore = await expense();

    const result = await runDepreciation(co.ctx, { periodEnd: `${year}-02-28` });

    assert.equal(result.assetsCharged, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.journalEntryId, null);
    assert.equal(
      (await expense()) - expenseBefore,
      0,
      're-running a period must not double the charge',
    );
  });

  test('a second period charges again', async () => {
    const expenseBefore = await expense();

    const result = await runDepreciation(co.ctx, { periodEnd: `${year}-03-31` });

    assert.equal(result.assetsCharged, 1);
    assert.equal((await expense()) - expenseBefore, 1000);

    const register = await getAssetRegister(co.ctx);
    const van = register.assets.find((a) => a.name === 'Delivery Van')!;
    assert.equal(Number(van.accumulatedDepreciation), 2000);
    assert.equal(Number(van.netBookValue), 58000);
  });

  test('an asset acquired after the period is not charged', async () => {
    const late = await createAsset(co.ctx, {
      name: 'Late Laptop',
      acquisitionDate: `${year}-11-01`,
      cost: '2400',
      usefulLifeMonths: 24,
    });

    // Running an earlier month must not touch it.
    const result = await runDepreciation(co.ctx, {
      periodEnd: `${year}-04-30`,
      assetId: late.id,
    });

    assert.equal(result.assetsCharged, 0);

    const { asset } = await getAsset(co.ctx, late.id);
    assert.equal(Number(asset.accumulatedDepreciation), 0);
  });

  test('a fully depreciated asset stops charging at residual value', async () => {
    // Short life so the end is reachable: 1,200 over 2 months, no residual.
    const asset = await createAsset(co.ctx, {
      name: 'Short Life Tool',
      acquisitionDate: `${year}-01-10`,
      cost: '1200',
      usefulLifeMonths: 2,
    });

    await runDepreciation(co.ctx, { periodEnd: `${year}-01-31`, assetId: asset.id });
    await runDepreciation(co.ctx, { periodEnd: `${year}-02-28`, assetId: asset.id });

    const afterTwo = await getAsset(co.ctx, asset.id);
    assert.equal(Number(afterTwo.asset.accumulatedDepreciation), 1200);
    assert.equal(Number(afterTwo.netBookValue), 0);

    // A third month has nothing left to charge.
    const third = await runDepreciation(co.ctx, {
      periodEnd: `${year}-03-31`,
      assetId: asset.id,
    });
    assert.equal(third.assetsCharged, 0);

    const afterThree = await getAsset(co.ctx, asset.id);
    assert.equal(
      Number(afterThree.asset.accumulatedDepreciation),
      1200,
      'an asset can never depreciate below its residual value',
    );
  });

  test('disposal at a profit derecognises the asset and posts a gain', async () => {
    const asset = await createAsset(co.ctx, {
      name: 'Sold Printer',
      acquisitionDate: `${year}-01-10`,
      cost: '3000',
      usefulLifeMonths: 30,
    });

    // One month of depreciation: 100. Net book value 2,900.
    await runDepreciation(co.ctx, { periodEnd: `${year}-01-31`, assetId: asset.id });

    const assetAccountBefore = await balanceOf('1210');
    const accumulatedBefore = await accumulated();

    // Sold for 3,500 against a book value of 2,900 → a 600 gain.
    const result = await disposeAsset(co.ctx, asset.id, {
      disposalDate: `${year}-02-15`,
      proceeds: '3500',
      proceedsAccountId: co.accountId('1120'),
      reason: 'Replaced with a newer model',
    });

    assert.equal(result.isGain, true);
    assert.equal(Number(result.gainOrLoss), 600);

    // Cost and accumulated depreciation are both removed from the books.
    assert.equal((await balanceOf('1210')) - assetAccountBefore, -3000);
    assert.equal((await accumulated()) - accumulatedBefore, -100);

    const { asset: disposed } = await getAsset(co.ctx, asset.id);
    assert.equal(disposed.status, 'disposed');
    assert.equal(Number(disposed.disposalProceeds), 3500);
  });

  test('disposal at a loss posts the loss', async () => {
    const asset = await createAsset(co.ctx, {
      name: 'Scrapped Machine',
      acquisitionDate: `${year}-01-10`,
      cost: '5000',
      usefulLifeMonths: 50,
    });

    // Scrapped for nothing against a 5,000 book value → a 5,000 loss.
    const result = await disposeAsset(co.ctx, asset.id, {
      disposalDate: `${year}-02-20`,
      proceeds: '0',
      reason: 'Beyond economic repair',
    });

    assert.equal(result.isGain, false);
    assert.equal(Number(result.gainOrLoss), -5000);
  });

  test('a disposed asset cannot be disposed of again or depreciated', async () => {
    const register = await getAssetRegister(co.ctx);
    const disposed = register.assets.find((a) => a.name === 'Scrapped Machine')!;

    await assert.rejects(
      disposeAsset(co.ctx, disposed.id, {
        disposalDate: `${year}-03-01`,
        proceeds: '100',
        reason: 'Again',
      }),
      /already been disposed/,
    );

    const run = await runDepreciation(co.ctx, {
      periodEnd: `${year}-04-30`,
      assetId: disposed.id,
    });
    assert.equal(run.assetsCharged, 0);
  });

  test('a disposal requires a reason', async () => {
    const asset = await createAsset(co.ctx, {
      name: 'Reasonless Asset',
      acquisitionDate: `${year}-01-10`,
      cost: '900',
      usefulLifeMonths: 9,
    });

    await assert.rejects(
      disposeAsset(co.ctx, asset.id, {
        disposalDate: `${year}-02-01`,
        proceeds: '100',
        reason: '   ',
      }),
      /needs a reason/,
    );
  });

  test('a depreciation run charges every eligible asset in one entry', async () => {
    const expenseBefore = await expense();

    // April: the van (1,000) and the reasonless asset (100) are both active.
    const result = await runDepreciation(co.ctx, { periodEnd: `${year}-04-30` });

    assert.ok(result.assetsCharged >= 2, 'multiple assets share one journal entry');
    assert.ok(result.journalEntryId);
    assert.equal(
      (await expense()) - expenseBefore,
      Number(result.totalCharge),
      'the ledger movement must equal the reported total charge',
    );
  });
});
