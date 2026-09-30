import { getCampaignSendFeedback } from '../../../shared/campaignSendFeedback.js';

/**
 * Keep campaign-send response interpretation separate from the toast library.
 * Callers provide the notifier so this remains straightforward to test.
 */
export function dispatchCampaignSendFeedback(result, notifier) {
  const feedback = getCampaignSendFeedback(result);
  notifier[feedback.type](feedback.message);
  return feedback;
}