import { supabase } from './database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from './tenantContext.js';
import { resolveTenantFromRequest } from './tenantResolver.js';
import { resolveFormAccess, sendFormAccessDenied } from './formAccessPolicy.js';
import { isFormScheduleAvailable } from './formAvailability.js';
import {
  FormRelationshipError,
  createFormRelationshipService,
} from './formRelationshipOptions.js';
import {
  isRepeatableRowField,
  repeatableRowChildren,
} from '../../shared/formRepeatableRows.js';
import { isCustomObjectRowSource } from '../../shared/formCustomObjectRowSources.js';
import { getSession, getSessionMember } from './session.js';
import {
  assignmentSubmissionRejection,
  requiresAssignmentLink,
} from './surveyAssignment.js';
import { activeVersionNumber } from './surveyScoring.js';
import { resolveTrustedSchemaCapabilities } from './customObjectSchemaAccess.js';

function failure(res, error) {
  const status = error instanceof FormRelationshipError ? error.status : 500;
  return res.status(status).json({
    error: status === 500 ? 'Failed to resolve form relationships' : error.message,
  });
}

export function createFormRelationshipDiscoveryHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const contextResolver = dependencies.getTenantContext || getTenantContext;
  const adminCheck = dependencies.hasAdminAccess || hasAdminAccess;
  const featureCheck = dependencies.hasFeatureAccess || hasFeatureAccess;
  const serviceFactory = dependencies.createService || createFormRelationshipService;
  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const context = await contextResolver(req);
      if (context?.tenantMismatch) throw new FormRelationshipError(409, 'Tenant context mismatch');
      if (!context?.isAuthenticated || !context?.tenantId) {
        throw new FormRelationshipError(401, 'Authentication required');
      }
      if (!await adminCheck(context)) throw new FormRelationshipError(403, 'Admin access required');
      const schemaCapabilities = await resolveTrustedSchemaCapabilities(context, {
        hasFeatureAccess: featureCheck,
      });
      const service = serviceFactory({ db, tenantId: context.tenantId });
      return res.status(200).json(await service.eligibleDefinitions(req.query.formId, {
        isTenantUser: Boolean(context.tenantUserId),
        roleId: context.roleId || null,
        ...schemaCapabilities,
      }));
    } catch (error) {
      return failure(res, error);
    }
  };
}

export function createPublicFormRelationshipOptionsHandler(dependencies = {}) {
  const db = dependencies.db || supabase;
  const tenantResolver = dependencies.resolveTenantFromRequest || resolveTenantFromRequest;
  const accessResolver = dependencies.resolveFormAccess || resolveFormAccess;
  const sessionResolver = dependencies.getSession || getSession;
  const sessionMemberResolver = dependencies.getSessionMember || getSessionMember;
  const serviceFactory = dependencies.createService || createFormRelationshipService;
  return async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const tenant = await tenantResolver(req);
      if (!tenant?.id) throw new FormRelationshipError(404, 'Tenant not found');
      const service = serviceFactory({ db, tenantId: tenant.id });
      const form = await service.loadForm({ slug: req.query.slug, activeOnly: true });
      if (!isFormScheduleAvailable(form)) throw new FormRelationshipError(404, 'Form not found');
      const access = await accessResolver({
        supabase: db,
        req,
        tenantId: tenant.id,
        policy: form.access_policy,
      });
      if (!access.allowed) return sendFormAccessDenied(res, access);
      const requestInput = req.method === 'POST' ? (req.body || {}) : req.query;
      let authoritativeForm = form;
      if (form.form_type === 'survey') {
        let hasValidSession = false;
        try {
          hasValidSession = Boolean(await sessionResolver(req));
        } catch {
          hasValidSession = false;
        }
        const surveyStatus = form.survey_settings?.status || 'draft';
        if (surveyStatus === 'archived' || (surveyStatus !== 'published' && !hasValidSession)) {
          throw new FormRelationshipError(404, 'Form not found');
        }

        const assignmentToken = requestInput.assignment_token;
        if (assignmentToken && surveyStatus !== 'published') {
          throw new FormRelationshipError(404, 'Form not found');
        }
        if (assignmentToken) {
          const { data: assignment, error: assignmentError } = await db
            .from('event_survey_assignment')
            .select('*')
            .eq('token', String(assignmentToken))
            .eq('tenant_id', tenant.id)
            .eq('form_id', form.id)
            .maybeSingle();
          if (assignmentError || !assignment) {
            throw new FormRelationshipError(404, 'Form not found');
          }
          let hasTenantSession = false;
          try {
            const member = await sessionMemberResolver(req);
            const memberTenantId = member?.tenant_id || member?.organization?.tenant_id || null;
            hasTenantSession = Boolean(member && memberTenantId === tenant.id);
          } catch {
            hasTenantSession = false;
          }
          const rejection = assignmentSubmissionRejection(assignment, { hasTenantSession });
          if (rejection) throw new FormRelationshipError(rejection.status, rejection.error);
        } else if (surveyStatus === 'published' && !hasValidSession) {
          const { data: activeAssignments, error: assignmentError } = await db
            .from('event_survey_assignment')
            .select('id')
            .eq('form_id', form.id)
            .eq('tenant_id', tenant.id)
            .eq('status', 'active')
            .limit(1);
          if (assignmentError) {
            throw new Error('Failed to resolve survey assignments');
          }
          if (requiresAssignmentLink(activeAssignments?.length)) {
            throw new FormRelationshipError(404, 'Form not found');
          }
        }

        if (surveyStatus === 'published') {
          const versionNumber = activeVersionNumber(form.survey_settings);
          if (versionNumber < 1) throw new FormRelationshipError(404, 'Form not found');
          const { data: snapshot, error: snapshotError } = await db
            .from('survey_version')
            .select('fields, pages, visibility_rules, survey_settings, version_number')
            .eq('form_id', form.id)
            .eq('tenant_id', tenant.id)
            .eq('version_number', versionNumber)
            .maybeSingle();
          if (snapshotError || !snapshot) {
            throw new FormRelationshipError(404, 'Form not found');
          }
          authoritativeForm = {
            ...form,
            fields: snapshot.fields || [],
            pages: snapshot.pages || [],
            visibility_rules: snapshot.visibility_rules || [],
            survey_settings: {
              ...(snapshot.survey_settings || {}),
              status: 'published',
              current_version: versionNumber,
            },
          };
        }
      }
      let optionForm = authoritativeForm;
       const containerFieldId = requestInput.containerFieldId;
      if (containerFieldId !== undefined && containerFieldId !== null && containerFieldId !== '') {
        const container = (authoritativeForm.fields || []).find(
          (field) => String(field?.id) === String(containerFieldId),
        );
        if (!container || !isRepeatableRowField(container)) {
          throw new FormRelationshipError(404, 'Repeatable row field not found');
        }
        const children = repeatableRowChildren(container);
         const child = children.find((field) => String(field?.id) === String(requestInput.fieldId));
        if (!child || child.type !== 'relationship_dropdown') {
          throw new FormRelationshipError(404, 'Relationship field not found');
        }
         if (child.option_source !== undefined && !isCustomObjectRowSource(child)) {
           throw new FormRelationshipError(409, 'Saved Custom Object row source configuration is invalid');
         }
         if (child.option_source !== undefined && req.method !== 'POST') {
           throw new FormRelationshipError(405, 'Custom Object row source options require POST');
         }
         if (child.option_source === undefined && req.method === 'POST') {
           throw new FormRelationshipError(405, 'Saved relationship options require GET');
         }
        // Keep the persisted root topology available to the service.  A child
        // can deliberately depend on a root field (form scope), rather than a
        // preceding field in its own row.
         optionForm = { ...authoritativeForm, fields: children };
      }
      return res.status(200).json(await service.relationshipOptions({
        slug: req.query.slug,
        form: optionForm,
         fieldId: requestInput.fieldId,
         parentRecordId: requestInput.parentRecordId || requestInput.organizationId,
        // organizationId remains a backwards-compatible public alias.
         organizationId: requestInput.organizationId,
         dependencyAnswers: requestInput.dependencyAnswers,
         query: requestInput,
        activeOnly: true,
         rootForm: authoritativeForm,
        containerFieldId,
      }));
    } catch (error) {
      return failure(res, error);
    }
  };
}