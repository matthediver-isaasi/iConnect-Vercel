import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const endpointUrl = new URL('./external-contacts.js', import.meta.url);
const migrationUrl = new URL(
  '../../supabase/migrations/20260828_audience_list_external_contacts.sql',
  import.meta.url,
);

test('endpoint has admin, tenant ownership, attribution, and race guards', async () => {
  const source = await readFile(endpointUrl, 'utf8');
  assert.match(source, /hasAdminAccess\(context\)/);
  assert.match(source, /\.from\('audience_list'\)[\s\S]*\.eq\('tenant_id', tenantId\)/);
  assert.match(source, /added_by_actor_label: actor\.label/);
  assert.match(source, /error\?\.code === '23505'/);
  assert.doesNotMatch(source, /\.from\(['"](?:member|email_subscriber)['"]\)\s*\.insert/);
});

test('schema enforces tenant/list ownership, cascade, uniqueness, and GDPR', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /FOREIGN KEY \(audience_list_id, tenant_id\)[\s\S]*ON DELETE CASCADE/);
  assert.match(sql, /UNIQUE \(audience_list_id, normalized_email\)/);
  assert.match(sql, /gdpr_acknowledged BOOLEAN NOT NULL CHECK \(gdpr_acknowledged IS TRUE\)/);
  assert.match(sql, /addition_source IN \('individual', 'csv_upload', 'pasted_rows'\)/);
  assert.match(sql, /actor_label_immutable/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
});

test('public response preserves one outcome per row and never trusts client audit fields', async () => {
  const source = await readFile(endpointUrl, 'utf8');
  assert.match(source, /rowNumber: outcome\.index \+ 1/);
  assert.match(source, /insertedCount: inserted/);
  assert.match(source, /added_by_tenant_user_id: actor\.tenantUserId/);
  assert.match(source, /added_by_member_id: actor\.memberId/);
  assert.match(source, /const \{ rows, source, gdprAcknowledged, dryRun \} = req\.body \|\| \{\}/);
});

test('campaign resolution, previews, and preferences share the normal recipient pipeline', async () => {
  const [campaignSource, listsSource, previewSource, countsSource, preferencesSource, unsubscribeSource] = await Promise.all([
    readFile(new URL('../_lib/campaignService.js', import.meta.url), 'utf8'),
    readFile(new URL('../audience-lists.js', import.meta.url), 'utf8'),
    readFile(new URL('./preview.js', import.meta.url), 'utf8'),
    readFile(new URL('./counts.js', import.meta.url), 'utf8'),
    readFile(new URL('../email-preferences/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../email-campaigns/unsubscribe.js', import.meta.url), 'utf8'),
  ]);

  assert.match(campaignSource, /\.from\('audience_list_external_contact'\)/);
  assert.match(campaignSource, /member_id: null/);
  assert.match(campaignSource, /getAudienceListRecipients\([\s\S]*visitedForChildren/);
  assert.match(campaignSource, /const emailLower = r\.email\.toLowerCase\(\)/);
  assert.match(campaignSource, /r\.bypass_opt_out === true \|\| !globalUnsubSet\.has/);
  assert.match(campaignSource, /member_id: r\.member_id !== undefined \? r\.member_id : r\.id/);
  assert.match(campaignSource, /if \(globalUnsubscribeError\) throw globalUnsubscribeError/);
  assert.match(campaignSource, /if \(prefError\) throw prefError/);
  assert.match(campaignSource, /if \(catUnsubError\) throw catUnsubError/);
  for (const adminSource of [listsSource, previewSource, countsSource]) {
    assert.match(adminSource, /!tenantContext\.isAuthenticated \|\| !tenantContext\.tenantId/);
    assert.match(adminSource, /hasAdminAccess\(tenantContext\)/);
  }
  assert.match(previewSource, /type: 'audience_list', ids: \[list\.id\]/);
  assert.match(countsSource, /type: 'audience_list', ids: \[list\.id\]/);
  assert.match(preferencesSource, /\.from\('email_unsubscribe'\)[\s\S]*unsubscribe_type', 'all'/);
  assert.match(preferencesSource, /email: normalizedEmail/);
  assert.match(unsubscribeSource, /recipient\.campaign_id !== campaignId/);
  assert.match(unsubscribeSource, /email: normalizedEmail/);
  assert.match(unsubscribeSource, /\.from\('member'\)[\s\S]*communications_opted_out_all: true/);
});