import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const endpoint = fs.readFileSync(new URL('../membership/email-fees.js', import.meta.url), 'utf8');
const tokenHelper = fs.readFileSync(new URL('./membershipFeeTokenEmail.js', import.meta.url), 'utf8');
const memberTab = fs.readFileSync(
  new URL('../../client/src/components/MemberMembershipTab.jsx', import.meta.url),
  'utf8',
);

const memberBranchAt = endpoint.indexOf('if (isMemberScoped)');
const sendAt = endpoint.indexOf('await sendMembershipFeeTokenEmail({');
assert.ok(memberBranchAt > -1 && sendAt > memberBranchAt, 'member email branch must precede delivery');

test('member fee email recalculates within the authenticated tenant and uses the member recipient', () => {
  assert.match(endpoint, /simulateMembershipForMember\(tenantId, memberId/);
  assert.match(endpoint, /const memberEmail = \(member\?\.email \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(endpoint.slice(sendAt), /memberId: isMemberScoped \? memberId : null/);
  assert.match(endpoint.slice(sendAt), /recipientEmails: toEmails/);
  assert.doesNotMatch(endpoint.slice(memberBranchAt, endpoint.indexOf('} else {', memberBranchAt)), /recipientEmail/);
});

test('member fee email is approval-gated and rejects an existing membership year before delivery', () => {
  const duplicateAt = endpoint.indexOf('if (isMemberScoped && simResult.existingRecord)');
  const approvalAt = endpoint.indexOf('await resolveMemberFeeApproval(supabase, {');
  assert.ok(duplicateAt > -1 && duplicateAt < sendAt);
  assert.ok(approvalAt > duplicateAt && approvalAt < sendAt);
  assert.match(endpoint.slice(duplicateAt, approvalAt), /membership_year_already_exists/);
  assert.match(endpoint.slice(approvalAt, sendAt), /membership_fees_not_approved/);
});

test('sending a member fee email records a member note without creating membership history', () => {
  assert.match(endpoint, /\.from\('member_note'\)\.insert\(\{/);
  assert.match(endpoint, /target_member_id: memberId/);
  assert.match(endpoint, /author_member_id: noteCreatorId/);
  assert.doesNotMatch(endpoint, /\.from\('member_membership_history'\)/);
});

test('pending member tokens are tenant/member/year scoped, refreshed, and terminal tokens are not reused', () => {
  const reuseAt = tokenHelper.indexOf('// Idempotency:');
  const insertAt = tokenHelper.indexOf("if (!token) {", reuseAt);
  const reuseBlock = tokenHelper.slice(reuseAt, insertAt);
  assert.match(reuseBlock, /\.eq\('tenant_id', tenantId\)/);
  assert.match(reuseBlock, /\.eq\('membership_year', membershipYear\)/);
  assert.match(reuseBlock, /\? existingQuery\.eq\('member_id', memberId\)/);
  assert.match(reuseBlock, /\.in\('status', \['pending', 'po_submitted'\]\)/);
  assert.match(reuseBlock, /existing\.status === 'pending'/);
  assert.doesNotMatch(reuseBlock, /'paid'|'expired'|'cancelled'/);
  assert.match(tokenHelper.slice(insertAt), /final_cost: finalCost/);
  assert.match(tokenHelper.slice(insertAt), /cost_breakdown: costBreakdown \|\| \{\}/);
});

test('member tab clearly separates calculated previews from recorded memberships', () => {
  assert.match(memberTab, /Calculated preview/);
  assert.match(memberTab, /'Preview Cost'/);
  assert.match(memberTab, /'Recorded Cost'/);
  assert.match(memberTab, /currentYearRecorded=\{currentYearRecorded\}/);
  assert.match(memberTab, /currentYearRecorded=\{nextYearRecorded\}/);
});

test('member tab exposes an approval-aware email action and confirmation feedback', () => {
  assert.match(memberTab, /data-testid=\{`button-member-email-fees-\$\{testIdPrefix\}`\}/);
  assert.match(memberTab, /approvalRequired && !feesApproved/);
  assert.match(memberTab, /body: JSON\.stringify\(\{ memberId, membershipYear \}\)/);
  assert.match(memberTab, /data-testid="button-member-email-fees-confirm"/);
  assert.match(memberTab, /Sending does not create a membership record/);
  assert.match(memberTab, /toast\.error\(error\.message\)/);
});