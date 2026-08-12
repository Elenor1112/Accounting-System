import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { and, eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { fiscalPeriods, journalEntries, journalLines } from '@/db/schema';
import { AccountingError } from '@/server/errors';
import {
  createJournalEntry,
  getAccountBalance,
  postJournalEntry,
  reverseJournalEntry,
  deleteDraftEntry,
} from '@/server/services/journal-service';

import { createTestCompany, destroyTestCompany, entryTotals, type TestCompany } from './harness';

describe('journal engine', () => {
  let co: TestCompany;

  before(async () => {
    co = await createTestCompany();
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  test('posts a balanced entry and stores both sides', async () => {
    const entry = await createJournalEntry(co.ctx, {
      entryDate: '2026-03-15',
      description: 'Owner capital injection',
      lines: [
        { accountId: co.accountId('1120'), debit: '50000' },
        { accountId: co.accountId('3100'), credit: '50000' },
      ],
      post: true,
    });

    assert.equal(entry.status, 'posted');
    assert.match(entry.entryNumber, /^JE-2026-\d{4}$/);

    const { debit, credit } = await entryTotals(entry.id);
    assert.equal(debit, 50000);
    assert.equal(credit, 50000);
  });

  test('rejects an unbalanced entry with a precise message', async () => {
    await assert.rejects(
      createJournalEntry(co.ctx, {
        entryDate: '2026-03-15',
        lines: [
          { accountId: co.accountId('1120'), debit: '100' },
          { accountId: co.accountId('3100'), credit: '90' },
        ],
      }),
      (err: Error) => {
        assert.ok(err instanceof AccountingError);
        assert.match(err.message, /does not balance/);
        return true;
      },
    );
  });

  test('rejects a line carrying both a debit and a credit', async () => {
    await assert.rejects(
      createJournalEntry(co.ctx, {
        entryDate: '2026-03-15',
        lines: [
          { accountId: co.accountId('1120'), debit: '100', credit: '100' },
          { accountId: co.accountId('3100'), credit: '100' },
        ],
      }),
      /cannot carry both a debit and a credit/,
    );
  });

  test('rejects a single-line entry', async () => {
    await assert.rejects(
      createJournalEntry(co.ctx, {
        entryDate: '2026-03-15',
        lines: [{ accountId: co.accountId('1120'), debit: '100' }],
      }),
      /at least two lines/,
    );
  });

  test('refuses to post to a control account by hand', async () => {
    // 1130 is Accounts Receivable, owned by the invoices subledger.
    await assert.rejects(
      createJournalEntry(co.ctx, {
        entryDate: '2026-03-15',
        lines: [
          { accountId: co.accountId('1130'), debit: '500' },
          { accountId: co.accountId('4100'), credit: '500' },
        ],
        post: true,
      }),
      /control account/,
    );
  });

  test('refuses to post to a summary (non-postable) parent account', async () => {
    await assert.rejects(
      createJournalEntry(co.ctx, {
        entryDate: '2026-03-15',
        lines: [
          { accountId: co.accountId('1000'), debit: '500' },
          { accountId: co.accountId('4100'), credit: '500' },
        ],
        post: true,
      }),
      /summary account/,
    );
  });

  test('a draft can be posted later, and posting is idempotent-guarded', async () => {
    const draft = await createJournalEntry(co.ctx, {
      entryDate: '2026-03-20',
      description: 'Accrued rent',
      lines: [
        { accountId: co.accountId('6200'), debit: '3000' },
        { accountId: co.accountId('2130'), credit: '3000' },
      ],
    });
    assert.equal(draft.status, 'draft');

    await postJournalEntry(co.ctx, draft.id);

    const [after] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, draft.id));
    assert.equal(after?.status, 'posted');
    assert.ok(after?.postedAt);

    await assert.rejects(postJournalEntry(co.ctx, draft.id), /already posted/);
  });

  test('a posted entry cannot be deleted', async () => {
    const entry = await createJournalEntry(co.ctx, {
      entryDate: '2026-03-21',
      lines: [
        { accountId: co.accountId('6300'), debit: '750' },
        { accountId: co.accountId('1120'), credit: '750' },
      ],
      post: true,
    });

    await assert.rejects(deleteDraftEntry(co.ctx, entry.id), /cannot be deleted/);
  });

  test('reversal mirrors the original and links both directions', async () => {
    const original = await createJournalEntry(co.ctx, {
      entryDate: '2026-04-01',
      description: 'Equipment purchase entered in error',
      lines: [
        { accountId: co.accountId('1210'), debit: '12000' },
        { accountId: co.accountId('1120'), credit: '12000' },
      ],
      post: true,
    });

    const reversal = await reverseJournalEntry(co.ctx, original.id, {
      reason: 'Wrong asset account',
    });

    const [originalRow] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, original.id));
    assert.equal(originalRow?.status, 'reversed');
    assert.equal(originalRow?.reversedByEntryId, reversal.id);

    const [reversalRow] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, reversal.id));
    assert.equal(reversalRow?.reversesEntryId, original.id);
    assert.equal(reversalRow?.status, 'posted');

    // The mirror image: what was debited is now credited.
    const reversalLines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, reversal.id));

    const equipmentLine = reversalLines.find(
      (l) => l.accountId === co.accountId('1210'),
    );
    assert.equal(Number(equipmentLine?.baseCredit), 12000);
    assert.equal(Number(equipmentLine?.baseDebit), 0);

    // Net effect on the account is zero once reversed.
    const balance = await getAccountBalance(co.ctx, co.accountId('1210'));
    assert.equal(Number(balance.balance), 0);
  });

  test('an entry cannot be reversed twice', async () => {
    const entry = await createJournalEntry(co.ctx, {
      entryDate: '2026-04-02',
      lines: [
        { accountId: co.accountId('6400'), debit: '200' },
        { accountId: co.accountId('1120'), credit: '200' },
      ],
      post: true,
    });

    await reverseJournalEntry(co.ctx, entry.id, { reason: 'duplicate' });
    await assert.rejects(
      reverseJournalEntry(co.ctx, entry.id, { reason: 'again' }),
      /already been reversed/,
    );
  });

  test('reversal requires a reason', async () => {
    const entry = await createJournalEntry(co.ctx, {
      entryDate: '2026-04-03',
      lines: [
        { accountId: co.accountId('6400'), debit: '100' },
        { accountId: co.accountId('1120'), credit: '100' },
      ],
      post: true,
    });

    await assert.rejects(
      reverseJournalEntry(co.ctx, entry.id, { reason: '   ' }),
      /reason is required/,
    );
  });

  test('posting into a closed period is refused', async () => {
    await db.insert(fiscalPeriods).values({
      companyId: co.companyId,
      fiscalYear: 2025,
      periodNumber: 1,
      name: 'January 2025',
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      status: 'closed',
    });

    await assert.rejects(
      createJournalEntry(co.ctx, {
        entryDate: '2025-01-15',
        lines: [
          { accountId: co.accountId('6200'), debit: '100' },
          { accountId: co.accountId('1120'), credit: '100' },
        ],
        post: true,
      }),
      /is closed/,
    );

    // A draft in the same period is fine — only posting is blocked.
    const draft = await createJournalEntry(co.ctx, {
      entryDate: '2025-01-15',
      lines: [
        { accountId: co.accountId('6200'), debit: '100' },
        { accountId: co.accountId('1120'), credit: '100' },
      ],
    });
    assert.equal(draft.status, 'draft');
  });

  test('posting into an open period records the period link', async () => {
    const [period] = await db
      .insert(fiscalPeriods)
      .values({
        companyId: co.companyId,
        fiscalYear: 2026,
        periodNumber: 6,
        name: 'June 2026',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        status: 'open',
      })
      .returning();

    const entry = await createJournalEntry(co.ctx, {
      entryDate: '2026-06-15',
      lines: [
        { accountId: co.accountId('6200'), debit: '400' },
        { accountId: co.accountId('1120'), credit: '400' },
      ],
      post: true,
    });

    const [row] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, entry.id));
    assert.equal(row?.periodId, period!.id);
  });

  test('multi-currency keeps the original amount and stores the base equivalent', async () => {
    // USD 1,000 invoice-style entry in a company whose base currency is USD…
    // use a foreign currency to exercise conversion: EUR 1,000 at 1.10.
    const entry = await createJournalEntry(co.ctx, {
      entryDate: '2026-05-01',
      currencyCode: 'EUR',
      exchangeRate: '1.10',
      description: 'EUR consulting fee',
      lines: [
        { accountId: co.accountId('1120'), debit: '1000' },
        { accountId: co.accountId('4100'), credit: '1000' },
      ],
      post: true,
    });

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, entry.id));

    const bankLine = lines.find((l) => l.accountId === co.accountId('1120'));
    // The transaction currency is preserved…
    assert.equal(Number(bankLine?.debit), 1000);
    assert.equal(bankLine?.currencyCode, 'EUR');
    // …and the base-currency equivalent is stored alongside it.
    assert.equal(Number(bankLine?.baseDebit), 1100);
  });

  test('base-currency entries reject a non-unit exchange rate', async () => {
    await assert.rejects(
      createJournalEntry(co.ctx, {
        entryDate: '2026-05-02',
        currencyCode: 'USD',
        exchangeRate: '1.5',
        lines: [
          { accountId: co.accountId('1120'), debit: '100' },
          { accountId: co.accountId('4100'), credit: '100' },
        ],
      }),
      /must be 1 when the entry is already in the base currency/,
    );
  });

  test('account balance reflects only posted entries', async () => {
    const account = co.accountId('6500');

    await createJournalEntry(co.ctx, {
      entryDate: '2026-07-01',
      lines: [
        { accountId: account, debit: '900' },
        { accountId: co.accountId('1120'), credit: '900' },
      ],
    }); // draft — must not count

    await createJournalEntry(co.ctx, {
      entryDate: '2026-07-02',
      lines: [
        { accountId: account, debit: '600' },
        { accountId: co.accountId('1120'), credit: '600' },
      ],
      post: true,
    });

    const balance = await getAccountBalance(co.ctx, account);
    assert.equal(Number(balance.debit), 600);
    assert.equal(Number(balance.balance), 600);
  });

  test('entry numbers are sequential per company', async () => {
    const first = await createJournalEntry(co.ctx, {
      entryDate: '2026-08-01',
      lines: [
        { accountId: co.accountId('6400'), debit: '10' },
        { accountId: co.accountId('1120'), credit: '10' },
      ],
    });
    const second = await createJournalEntry(co.ctx, {
      entryDate: '2026-08-01',
      lines: [
        { accountId: co.accountId('6400'), debit: '20' },
        { accountId: co.accountId('1120'), credit: '20' },
      ],
    });

    const firstSeq = Number(first.entryNumber.split('-').pop());
    const secondSeq = Number(second.entryNumber.split('-').pop());
    assert.equal(secondSeq, firstSeq + 1);
  });
});
