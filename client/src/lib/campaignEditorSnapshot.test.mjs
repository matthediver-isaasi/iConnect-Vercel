import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignEditorSnapshot } from './campaignEditorSnapshot.js';
const initial = () => ({ formData: { name: '', subject: '', from_name: '', from_email: '', reply_to: '',
  email_template_id: '', communication_category_id: '', html_content: '', design_json: null,
  event_survey_context: null, scheduled_at: '', is_test_mode: false, deliver_to_inbox_when_opted_out: false },
  directAudienceType: 'audience_list', selectedAudienceIds: ['b', 'a'], scheduleMode: 'immediate',
  reviewSelections: { audience: false, category: false }, reviewConfirmed: false });
test('snapshot covers every persisted field, audience, review and scheduling state', () => {
  const before = initial();
  for (const [key, value] of Object.entries(before.formData)) {
    const after = initial();
    after.formData[key] = typeof value === 'boolean' ? !value : key === 'design_json'
      ? { blocks: [] } : key === 'event_survey_context' ? { event_id: 'event' } : 'changed';
    assert.notEqual(campaignEditorSnapshot(before), campaignEditorSnapshot(after), key);
  }
  for (const patch of [
    { selectedAudienceIds: [] }, { directAudienceType: 'event_attendees' }, { scheduleMode: 'scheduled' },
    { reviewSelections: { audience: true, category: false } }, { reviewConfirmed: true },
  ]) assert.notEqual(campaignEditorSnapshot(before), campaignEditorSnapshot({ ...before, ...patch }));
});
test('snapshot ignores derived HTML, API-only fields, metadata and selection order', () => {
  const before = initial();
  before.formData.design_json = { blocks: [] };
  const after = structuredClone(before);
  after.formData.html_content = '<p>Regenerated footer</p>';
  after.formData.target_type = 'audience_list';
  after.formData.target_ids = ['a', 'b'];
  after.formData.category_review_confirmed = true;
  after.formData.target_audiences = [{ type: 'audience_list', ids: ['a', 'b'] }];
  after.formData.communication_category_id = null;
  after.formData.email_template_id = null;
  after.selectedAudienceIds.reverse();
  after.previewMode = 'mobile';
  assert.equal(campaignEditorSnapshot(before), campaignEditorSnapshot(after));
});
