/**
 * Creates an invoice and drives it through the approval chain to posted.
 *
 * Temporary diagnostic script: reproduces what the "Approve & post" button
 * does, using the same service functions the UI calls, so the blocking step
 * is visible without guessing.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { and, eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { contacts, memberships, roles, users } from '@/db/schema';
import { resolveTenantContext } from '@/server/auth/context';
import { createDocument, postDocument } from '@/server/services/document-service';
import { decideApproval, getApprovalStatus } from '@/server/services/workflow-service';

const CUSTOMER = '1a6fd8ae-d76a-4a15-b9ca-70c791c3c52e'; // Acme Corporation
const REVENUE = '28ea17eb-4ecb-4ad4-bb65-da2eeff6157e'; // 4100 Sales Revenue
const VAT10 = '62530656-f641-42a8-a241-0c0b4ac2ba1d';

async function contextFor(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error(`no user ${email}`);
  const [m] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (!m) throw new Error(`${email} has no membership`);
  return resolveTenantContext({ userId: user.id, companyId: m.companyId });
}

async function main() {
  const owner = await contextFor('owner@demo.test');
  console.log(`owner ctx: role=${owner.roleKey} company=${owner.companyName}`);

  const [customer] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, CUSTOMER))
    .limit(1);

  const doc = await createDocument(owner, {
    direction: 'outbound',
    documentType: 'invoice',
    contactId: CUSTOMER,
    issueDate: new Date().toISOString().slice(0, 10),
    lines: [
      {
        description: 'Consulting services — August 2026',
        quantity: '10',
        unitPrice: '250',
        accountId: REVENUE,
        taxId: VAT10,
      },
    ],
  } as never);

  console.log(`\ncreated ${doc.documentNumber} for ${customer?.displayName}`);
  console.log(`  subtotal=${doc.subtotal} tax=${doc.taxTotal} total=${doc.total}`);
  console.log(`  status=${doc.status}`);

  // Step 1: what the button does.
  const posted = await postDocument(owner, doc.id);
  console.log('\npostDocument(owner) ->', JSON.stringify(posted));

  const chain = await getApprovalStatus(owner, 'document', doc.id);
  console.log('approval chain:', JSON.stringify(chain, null, 2));

  // Step 2: the chain needs an accountant. Find or make one.
  let approverEmail = 'accountant@demo.test';
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.email, approverEmail))
    .limit(1);

  if (!existing) {
    console.log('\nno accountant user exists — creating one via inviteUser()');
    const [role] = await db
      .select()
      .from(roles)
      .where(and(eq(roles.key, 'accountant'), eq(roles.organizationId, owner.organizationId)))
      .limit(1);
    if (!role) throw new Error('no accountant role');

    const { inviteUser } = await import('@/server/services/company-service');
    await inviteUser(owner, {
      email: approverEmail,
      name: 'Demo Accountant',
      password: 'demo-password-123',
      roleId: role.id,
    });
    console.log(`  created ${approverEmail} with role accountant`);
  }

  const accountant = await contextFor(approverEmail);
  console.log(`accountant ctx: role=${accountant.roleKey}`);

  const decision = await decideApproval(accountant, {
    entityType: 'document',
    entityId: doc.id,
    decision: 'approved',
    comment: 'Reviewed — approved for posting.',
  });
  console.log('\ndecideApproval(accountant) ->', JSON.stringify(decision));

  const final = await getApprovalStatus(accountant, 'document', doc.id);
  console.log('final chain:', JSON.stringify(final, null, 2));

  const [row] = await db
    .select()
    .from((await import('@/db/schema')).documents)
    .where(eq((await import('@/db/schema')).documents.id, doc.id))
    .limit(1);
  console.log('\nFINAL DOCUMENT:');
  console.log(`  number=${row!.documentNumber}`);
  console.log(`  status=${row!.status}`);
  console.log(`  journalEntryId=${row!.journalEntryId}`);
  console.log(`  approvedById=${row!.approvedById}`);
  console.log(`  approvedAt=${row!.approvedAt}`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error('\nFAILED:', err.message);
    console.error(err.stack);
    await closeDb();
    process.exit(1);
  });
