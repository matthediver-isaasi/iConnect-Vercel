import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('all send, schedule, resume, worker and manual recovery paths enforce category review', async () => {
  const [service, recovery] = await Promise.all([
    readFile(new URL('../_lib/campaignService.js', import.meta.url), 'utf8'),
    readFile(new URL('./resume-graftas.js', import.meta.url), 'utf8'),
  ]);
  assert.match(service, /scheduleCampaign[\s\S]*campaign\.category_review_required/);
  assert.match(service, /resumeCampaign[\s\S]*campaign\.category_review_required/);
  assert.match(service, /sendCampaign[\s\S]*campaign\.category_review_required/);
  assert.match(service, /\.eq\('status', 'scheduled'\)[\s\S]*\.eq\('category_review_required', false\)/);
  assert.match(service, /\.eq\('status', 'sending'\)[\s\S]*\.eq\('category_review_required', false\)/);
  assert.match(service, /delete cleanedUpdates\.category_review_required/);
  assert.match(recovery, /category_review_required/);
  assert.match(service, /createCampaign[\s\S]*validateCampaignAudienceLists/);
  assert.match(service, /createCampaign[\s\S]*delete cleanedData\.category_review_required/);
  assert.match(service, /updateCampaign[\s\S]*validateCampaignAudienceLists/);
  assert.match(service, /resumeCampaign[\s\S]*validateCampaignAudienceLists/);
  assert.match(service, /getTargetRecipients[\s\S]*validateCampaignAudienceLists/);
  assert.match(service, /scheduleCampaign[\s\S]*validateCampaignAudienceLists/);
  assert.match(service, /sendCampaign[\s\S]*validateCampaignAudienceLists/);
  assert.match(service, /getAudienceListRecipients[\s\S]*category_review_required/);
  assert.match(service, /duplicateCampaign[\s\S]*category_review_required:\s*original\.category_review_required\s*\|\|\s*!listValidation\.valid/);
});

test('generic category delete is one authorized atomic RPC with retryable conflict mapping', async () => {
  const [source, collection] = await Promise.all([
    readFile(new URL('../entities/[entity]/[id].js', import.meta.url), 'utf8'),
    readFile(new URL('../entities/[entity]/index.js', import.meta.url), 'utf8'),
  ]);
  assert.match(source, /entityNorm === 'communicationcategory'/);
  assert.match(source, /hasAdminAccess\(tenantCtx\)/);
  assert.match(source, /delete_communication_category_preserving_campaigns/);
  assert.match(source, /CATEGORY_DELETE_ACTIVE_CAMPAIGN/);
  assert.doesNotMatch(source, /CommunicationCategory Delete/);
  assert.match(source, /entityNorm === 'emailcampaign'[\s\S]*delete req\.body\?\.\[field\]/);
  assert.match(source, /'target_type',[\s\S]*'target_ids',[\s\S]*'target_audiences'/);
  assert.match(collection, /entityNorm === 'emailcampaign' && req\.method === 'POST'/);
});

test('campaign endpoints validate direct audience-list payloads and expose replacement instructions', async () => {
  const [collection, detail, editor] = await Promise.all([
    readFile(new URL('./index.js', import.meta.url), 'utf8'),
    readFile(new URL('./[id].js', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/EmailCampaignEdit.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(collection, /createCampaign\(campaignData, tenantId, memberId\)/);
  assert.match(collection, /AUDIENCE_LIST_REPLACEMENT_REQUIRED/);
  assert.match(detail, /updateCampaign\(id, updates, tenantId\)/);
  assert.match(detail, /AUDIENCE_LIST_REPLACEMENT_REQUIRED/);
  assert.match(editor, /category_review_required === true/);
  assert.match(editor, /cannot be selected\. Create or select a valid replacement list/);
});

test('missing communication-category segments resolve only explicit subscribers and never all members', async () => {
  const source = await readFile(new URL('../_lib/campaignService.js', import.meta.url), 'utf8');
  const start = source.indexOf("if (targetType === 'communication_category'");
  const end = source.indexOf("} else if (targetType === 'member_group'", start);
  assert.ok(start >= 0 && end > start);
  const categoryBranch = source.slice(start, end);
  assert.match(categoryBranch, /getExplicitCategoryMemberRecipients\(targetIds, tenantId\)/);
  assert.match(categoryBranch, /\.in\('communication_category_id', targetIds\)/);
  assert.doesNotMatch(categoryBranch, /all_members|recipients\s*=\s*tenantMembers/);
});