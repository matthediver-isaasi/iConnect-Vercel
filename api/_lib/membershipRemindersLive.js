import { supabase } from './database.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from './membershipSimulation.js';
import { sendTenantEmail } from './tenantEmailService.js';
import { replacePlaceholders } from './emailPlaceholderCore.js';
import { buildInboxDelivery, recordTransactionalInboxMessage, resolveCommunicationCategoryIdForLabel } from './transactionalInbox.js';
import { getPausedMemberIdSet } from './memberPause.js';
import { prepareMembershipFeeToken } from './membershipFeeTokenEmail.js';
import { loadApprovedAddonLines, computeAddonTotals, buildAddonDisplayLines } from './membershipOwnerReadHelpers.js';
import { readStripeCredentials } from './stripeCredentialReadCore.js';
import { createMembershipReminders } from './membershipReminders.js';
export { rollingReminderCandidates, rollingReminderSendDate } from './membershipReminders.js';

export function reminderLiveEffects(db = supabase) {
  return { async perform(operation) {
    const p = operation.payload;
    switch (operation.type) {
      case 'reminder.prepare_token': return prepareMembershipFeeToken({ ...p, client: db });
      case 'reminder.email': return sendTenantEmail(p);
      case 'reminder.inbox_delivery': return buildInboxDelivery(p);
      case 'reminder.inbox_record': return recordTransactionalInboxMessage(p);
      case 'reminder.category': return resolveCommunicationCategoryIdForLabel(p.tenantId, p.label);
      case 'reminder.log': return db.from('membership_tier_reminder_send').insert(p);
      case 'reminder.finish': return db.from('membership_tier_reminder_send').update(p.values)
        .eq('id', p.id).eq('tenant_id', p.tenantId).eq('status', 'processing').eq('sent_at', p.sentAt);
      case 'reminder.claim': {
        if (!p.prior) return db.from('membership_tier_reminder_send')
          .insert({ ...p.identity, status: 'processing', sent_at: p.sentAt }).select('id, sent_at').maybeSingle();
        return db.from('membership_tier_reminder_send').update({ status: 'processing', sent_at: p.sentAt, error: null })
          .eq('id', p.prior.id).eq('tenant_id', p.identity.tenant_id).eq('status', p.prior.status).eq('sent_at', p.prior.sent_at)
          .select('id, sent_at').maybeSingle();
      }
      default: throw new Error(`Unknown reminder operation: ${operation.type}`);
    }
  } };
}
const live = (db = supabase) => createMembershipReminders({
  db, simulateMembershipForOrg, simulateMembershipForMember, replacePlaceholders,
  getPausedMemberIdSet, loadAddonLines: (...args) => loadApprovedAddonLines(db, ...args), computeAddonTotals, buildAddonDisplayLines,
  getStripeCredentials: (tenantId, feature) => readStripeCredentials(db, tenantId, feature, {
    encryptionKey: process.env.INTEGRATION_ENCRYPTION_KEY || process.env.SESSION_SECRET,
  }), effects: reminderLiveEffects(db),
});
export const processTenantReminders = (...args) => live().processTenantReminders(...args);
export const getRemindersForConfig = (...args) => live().getRemindersForConfig(...args);
export const saveRemindersForConfig = (...args) => live().saveRemindersForConfig(...args);
export const claimRollingReminder = (db, ...args) => live(db).claimRollingReminder(db, ...args);