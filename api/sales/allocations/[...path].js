import { supabase } from '../../_lib/database.js';
import { getTenantContext } from '../../_lib/tenantContext.js';
import { getTrustedBaseUrlForTenant } from '../../_lib/publicBaseUrl.js';
import { sendEmail } from '../../_lib/emailService.js';
import { SALES_CAPABILITIES } from '../../../shared/salesContracts.js';
import { requireSalesContext, SalesHttpError } from '../../_lib/salesAccess.js';
import {
  getAllocation,
  getManagerAllocationDetail,
  listAllocations,
  listManagerAllocations,
  moveAllocation,
  reconcileAllocationBooking,
  validateAllocationInput,
} from '../../_lib/salesCommercialAllocation.js';
import {
  grantAllocationManager,
  getPublicAllocationInvitationContext,
  releaseAllocationInvitation,
  requireAllocationManager,
  reserveAllocationInvitation,
} from '../../_lib/allocationInvitation.js';

function pathParts(req) {
  const path = req.query?.path;
  if (path) return Array.isArray(path) ? path : String(path).split('/').filter(Boolean);
  return [req.query?.id, req.query?.action].filter(Boolean);
}

export function createSalesAllocationsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const sendInvitationEmail = dependencies.sendEmail || sendEmail;
  const trustedBaseUrl = dependencies.getTrustedBaseUrlForTenant || getTrustedBaseUrlForTenant;
  const getInvitationContext = dependencies.getPublicAllocationInvitationContext || getPublicAllocationInvitationContext;
  return async function handler(req, res) {
    try {
      if (!db) throw new SalesHttpError(503, 'Database not configured');
      const [id, action] = pathParts(req);
      const context = await getContext(req);
      if (context?.tenantMismatch) throw new SalesHttpError(409, 'Tenant context mismatch');
      if (!context?.isAuthenticated) throw new SalesHttpError(401, 'Authentication required');
      if (!context?.tenantId) throw new SalesHttpError(400, 'Tenant context not found');

      // Tenant dashboard users retain the Sales RBAC contract. Organisation
      // members are deliberately a separate, grant-only surface: requiring
      // global Sales capability here would make an explicit allocation grant
      // unusable, while granting it would expose all commercial lifecycle
      // controls.
      const isMemberManager = !context.tenantUserId && !!context.memberId;
      let actor;
      if (isMemberManager) {
        actor = { tenantId: context.tenantId, actorId: context.memberId, actorType: 'member' };
        const permitted = req.method === 'GET'
          || (req.method === 'POST' && id && ['invite', 'release-invite'].includes(action));
        if (!permitted) throw new SalesHttpError(403, 'Allocation managers cannot perform commercial lifecycle actions');
      } else {
        actor = await requireSalesContext(
          context,
          req.method === 'GET' ? SALES_CAPABILITIES.VIEW : SALES_CAPABILITIES.MANAGE_ALLOCATIONS,
          dependencies,
        );
      }
      const managerGrant = id && actor.actorType === 'member'
        ? await requireAllocationManager(db, actor.tenantId, id, actor.actorId)
        : null;

      if (req.method === 'GET' && !id) {
        return res.status(200).json({
          items: actor.actorType === 'member'
            ? await listManagerAllocations(db, actor.tenantId, actor.actorId, req.query || {})
            : await listAllocations(db, actor.tenantId, req.query || {}),
        });
      }
      if (req.method === 'GET' && id && !action) {
        return res.status(200).json(actor.actorType === 'member'
          ? await getManagerAllocationDetail(db, actor.tenantId, id, managerGrant.id)
          : await getAllocation(db, actor.tenantId, id));
      }
      if (req.method === 'POST' && id && ['release', 'cancel', 'reconcile'].includes(action)) {
        const errors = validateAllocationInput(req.body, { reconcile: action === 'reconcile' });
        if (errors.length) return res.status(400).json({ error: 'Invalid allocation movement', details: errors });
        const result = action === 'reconcile'
          ? await reconcileAllocationBooking(db, actor.tenantId, actor, id, req.body)
          : await moveAllocation(db, actor.tenantId, actor, id, action === 'release' ? 'released' : 'cancelled', req.body);
        return res.status(200).json(result);
      }
      if (req.method === 'POST' && id && action === 'invite') {
        const input = req.body || {};
        const expires = new Date(input.expiresAt);
        if (!input.email || !input.idempotencyKey || !Number.isFinite(expires.getTime())) {
          return res.status(400).json({ error: 'email, expiresAt, and idempotencyKey are required' });
        }
        const result = await reserveAllocationInvitation(
          db, actor.tenantId, id, actor, { ...input, expiresAt: expires.toISOString() },
        );
        let invitationContext;
        try {
          invitationContext = await getInvitationContext(db, result.token);
          const path = invitationContext.eventSlug
            ? `${invitationContext.eventKind === 'complex' ? '/session-events/' : '/events/'}${encodeURIComponent(invitationContext.eventSlug)}`
            : `${invitationContext.eventKind === 'complex' ? '/ComplexEventDetail' : '/EventDetails'}?id=${encodeURIComponent(invitationContext.eventId)}`;
          const separator = path.includes('?') ? '&' : '?';
          const registrationUrl = `${await trustedBaseUrl(req, db, actor.tenantId)}${path}${separator}allocation=${encodeURIComponent(result.token)}`;
          if (input.sendEmail !== false) {
            const emailResult = await sendInvitationEmail({
              to: invitationContext.delegateEmail,
              tenantId: actor.tenantId,
              subject: `Registration invitation: ${invitationContext.eventName}`,
              text: `You have been invited to register for ${invitationContext.eventName}. Register securely: ${registrationUrl}`,
              html: `<p>You have been invited to register for <strong>${invitationContext.eventName}</strong>.</p><p><a href="${registrationUrl}">Register securely</a></p>`,
            });
            if (!emailResult?.success) {
              if (!result.replayed) {
                await releaseAllocationInvitation(db, actor.tenantId, result.invitationId, actor);
              }
              throw new SalesHttpError(502, result.replayed
                ? `Invitation email retry failed; the existing reservation remains active: ${emailResult?.error || 'email delivery failed'}`
                : `Invitation email could not be sent; the reserved place was released: ${emailResult?.error || 'email delivery failed'}`);
            }
          }
          return res.status(201).json({
            invitationId: result.invitationId,
            expiresAt: result.expiresAt,
            registration_url: registrationUrl,
            context_token: result.token,
            email_sent: input.sendEmail !== false,
          });
        } catch (error) {
          // Context failures occur before delivery and must not strand a place.
          if (!result.replayed && (!(error instanceof SalesHttpError) || error.status !== 502)) {
            await releaseAllocationInvitation(db, actor.tenantId, result.invitationId, actor);
          }
          throw error;
        }
      }
      if (req.method === 'POST' && id && action === 'grant-manager') {
        const input = req.body || {};
        if (!input.organizationId || !input.memberId || !input.idempotencyKey) {
          return res.status(400).json({
            error: 'organizationId, memberId, and idempotencyKey are required',
          });
        }
        return res.status(201).json(await grantAllocationManager(
          db, actor.tenantId, id, actor, input,
        ));
      }
      if (req.method === 'POST' && id && action === 'release-invite') {
        if (!req.body?.invitationId) {
          return res.status(400).json({ error: 'invitationId is required' });
        }
        return res.status(200).json(await releaseAllocationInvitation(
          db, actor.tenantId, req.body.invitationId, actor,
        ));
      }
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      const status = error instanceof SalesHttpError ? error.status : 500;
      return res.status(status).json({ error: status === 500 ? 'Failed to handle Sales allocation' : error.message });
    }
  };
}

export default createSalesAllocationsHandler();
