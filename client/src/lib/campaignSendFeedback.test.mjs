import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { dispatchCampaignSendFeedback } from './campaignSendFeedback.js';

function recordingNotifier() {
  const calls = [];
  return {
    calls,
    success: (message) => calls.push({ type: 'success', message }),
    warning: (message) => calls.push({ type: 'warning', message }),
    error: (message) => calls.push({ type: 'error', message }),
    info: (message) => calls.push({ type: 'info', message }),
  };
}

test('dispatches partial campaign sends as warnings with provider-acceptance wording', () => {
  const notifier = recordingNotifier();

  const feedback = dispatchCampaignSendFeedback({
    status: 'sent',
    sent: 3,
    failed: 2,
    failures: [{ email: 'failed@example.com', error: 'Rejected' }],
  }, notifier);

  assert.equal(feedback.type, 'warning');
  assert.deepEqual(notifier.calls, [{
    type: 'warning',
    message: '3 emails accepted by the provider. Delivery is not yet confirmed. 2 emails failed: failed@example.com: Rejected',
  }]);
});

test('dispatches a 200 response with no accepted recipients as an error', () => {
  const notifier = recordingNotifier();

  dispatchCampaignSendFeedback({
    status: 'sent',
    sent: 0,
    failed: 1,
    failures: [{ email: 'failed@example.com', error: 'Suppressed' }],
  }, notifier);

  assert.deepEqual(notifier.calls, [{
    type: 'error',
    message: 'No emails were accepted by the provider. 1 email failed: failed@example.com: Suppressed',
  }]);
});

test('active send UIs dispatch shared feedback while test sends stay distinct', async () => {
  const [editor, groupManager] = await Promise.all([
    readFile(new URL('../pages/EmailCampaignEdit.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/group-email/GroupEmailManager.jsx', import.meta.url), 'utf8'),
  ]);

  const editorActiveSend = editor.slice(
    editor.indexOf('const handleSendCampaign = async'),
    editor.indexOf('const hasAudienceSelected'),
  );
  const editorTestSend = editor.slice(
    editor.indexOf('const handleTestSend = async'),
    editor.indexOf('const handleOpenSendConfirm'),
  );
  const groupActiveSend = groupManager.slice(
    groupManager.indexOf('const handleSendNow = async'),
    groupManager.indexOf('const handleSchedule = async'),
  );
  const groupTestSend = groupManager.slice(
    groupManager.indexOf('const handleTestSend = async'),
    groupManager.indexOf('const deleteCampaign'),
  );

  assert.match(editor, /import \{ dispatchCampaignSendFeedback \} from "@\/lib\/campaignSendFeedback"/);
  assert.match(groupManager, /import \{ dispatchCampaignSendFeedback \} from "@\/lib\/campaignSendFeedback"/);
  assert.match(editorActiveSend, /dispatchCampaignSendFeedback\(result, toast\)/);
  assert.match(groupActiveSend, /dispatchCampaignSendFeedback\(data, toast\)/);
  assert.doesNotMatch(editorTestSend, /dispatchCampaignSendFeedback/);
  assert.doesNotMatch(groupTestSend, /dispatchCampaignSendFeedback/);
});