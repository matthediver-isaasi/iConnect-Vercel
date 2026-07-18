// AI Composition prompt-led editing endpoint — Phase 2 (Task #2850).
//
// Routes:
//   GET  /api/ai-compositions/edit?compositionId=…       → conversation history
//   POST /api/ai-compositions/edit  { action, ... }
//     action 'propose': { compositionId, instruction, target?, breakpoint?,
//                         resolvedDestination? } → runs the edit pipeline and
//       stores the proposal server-side. Returns the preview document,
//       summary, warnings (protected-value violations), or — for the link
//       workflow — destination candidates to disambiguate.
//     action 'accept':  { conversationId, confirmProtected? } → re-applies the
//       STORED proposal against the CURRENT document server-side (the client
//       is never trusted with the document), creates a version. Patch/section
//       edits become the current version; complete redesigns are saved as an
//       alternative WITHOUT switching the current version (spec §15).
//     action 'reject':  { conversationId }
//     action 'undo':    { compositionId } → revert current_version_id to the
//       current version's parent (most recent accepted change).
//
// Editors only; 404 (not 403) so composition existence never leaks.

import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import {
  runEditProposal,
  buildDestinationLinkOp,
  resolveTarget,
  normalizeBreakpointScope,
  normalizeInstruction,
  assessAccept,
} from '../_lib/aiCompositionEdit.js';
import {
  applyPatch,
  diffProtectedValues,
  checkBreakpointIsolation,
  collectLinkRefs,
} from '../_lib/aiCompositionPatch.js';

function getOpenAIClient() {
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
}

function makeCallLlm(client) {
  return async ({ system, user, maxTokens }) => {
    let completion;
    try {
      completion = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.4,
        max_completion_tokens: maxTokens || 4000,
      });
    } catch {
      throw Object.assign(
        new Error('The AI service is temporarily unavailable. Nothing was changed — please try again.'),
        { httpStatus: 502, providerError: true },
      );
    }
    return completion.choices?.[0]?.message?.content || '';
  };
}

async function buildBrandContext(tenantId) {
  const { data: tenantData } = await supabase
    .from('tenant')
    .select('name, primary_color, secondary_color, description')
    .eq('id', tenantId)
    .maybeSingle();
  if (!tenantData) return null;
  const { data: fonts } = await supabase
    .from('installed_font')
    .select('family')
    .eq('tenant_id', tenantId)
    .limit(20);
  return {
    name: tenantData.name,
    primaryColor: tenantData.primary_color || null,
    secondaryColor: tenantData.secondary_color || null,
    tone: tenantData.description || null,
    fonts: Array.isArray(fonts) ? fonts.map((f) => f.family).filter(Boolean) : [],
  };
}

async function loadComposition(id, tenantId) {
  const { data: comp } = await supabase
    .from('ai_composition')
    .select('id, tenant_id, page_id, name, composition_type, current_version_id')
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!comp || !comp.current_version_id) return null;
  const { data: version } = await supabase
    .from('ai_composition_version')
    .select('id, parent_version_id, document')
    .eq('id', comp.current_version_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!version?.document) return null;
  return { comp, version, doc: version.document };
}

/** Broken-link check: every internal record ref must exist in this tenant. */
async function findBrokenLinks(doc, tenantId) {
  const refs = collectLinkRefs(doc);
  const broken = [];
  for (const ref of refs) {
    const { data } = await supabase
      .from(ref.table)
      .select('id')
      .eq('id', ref.id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!data) broken.push({ elementId: ref.elementId, kind: ref.kind, id: ref.id });
  }
  return broken;
}

const DESTINATION_KINDS = ['page', 'event_registration', 'form', 'document', 'membership_application', 'external', 'email', 'tel', 'anchor'];

async function searchDestinations(tenantId, q) {
  const like = `%${q}%`;
  const [pages, events, forms, files, tiers] = await Promise.all([
    supabase.from('i_edit_page').select('id, title, slug').eq('tenant_id', tenantId).is('microsite_id', null).ilike('title', like).limit(6),
    supabase.from('event').select('id, title, start_date').eq('tenant_id', tenantId).ilike('title', like).order('start_date', { ascending: false }).limit(6),
    supabase.from('form').select('id, name, slug').eq('tenant_id', tenantId).ilike('name', like).limit(6),
    supabase.from('file_repository').select('id, file_name').eq('tenant_id', tenantId).ilike('file_name', like).limit(6),
    supabase.from('membership_tier_config').select('id, name').eq('tenant_id', tenantId).eq('is_active', true).ilike('name', like).limit(6),
  ]);
  return [
    ...(pages.data || []).map((r) => ({ kind: 'page', id: r.id, slug: r.slug, title: r.title || r.slug, detail: `Page · /${r.slug}` })),
    ...(events.data || []).map((r) => ({ kind: 'event_registration', id: r.id, title: r.title, detail: r.start_date ? `Event · ${String(r.start_date).slice(0, 10)}` : 'Event' })),
    ...(forms.data || []).map((r) => ({ kind: 'form', id: r.id, slug: r.slug || null, title: r.name, detail: 'Form' })),
    ...(files.data || []).map((r) => ({ kind: 'document', id: r.id, title: r.file_name, detail: 'Document' })),
    ...(tiers.data || []).map((r) => ({ kind: 'membership_application', id: r.id, title: r.name, detail: 'Membership tier' })),
  ];
}

/** Verify a user-picked destination actually exists in this tenant. */
async function verifyDestination(tenantId, destination) {
  const d = destination || {};
  if (!DESTINATION_KINDS.includes(d.kind)) return false;
  const tables = {
    page: 'i_edit_page',
    event_registration: 'event',
    form: 'form',
    document: 'file_repository',
    membership_application: 'membership_tier_config',
  };
  if (!tables[d.kind]) return true; // external/email/tel/anchor validated by schema
  if (!d.id) return d.kind === 'membership_application'; // tierId optional
  const { data } = await supabase
    .from(tables[d.kind])
    .select('id')
    .eq('id', d.id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return !!data;
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  let canEdit = !!context.tenantUserId;
  if (!canEdit && context.roleId) {
    canEdit = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEdit) return res.status(404).json({ error: 'Not found' });
  const tenantId = context.tenantId;

  // ---- GET: conversation history -----------------------------------------
  if (req.method === 'GET') {
    const compositionId = req.query?.compositionId;
    if (!compositionId) return res.status(400).json({ error: 'compositionId required' });
    const { data: comp } = await supabase
      .from('ai_composition')
      .select('id')
      .eq('id', compositionId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!comp) return res.status(404).json({ error: 'Not found' });
    const { data: rows } = await supabase
      .from('ai_composition_conversation')
      .select('id, instruction, target, breakpoint, kind, summary, warnings, status, version_id, created_by, created_at')
      .eq('composition_id', compositionId)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(50);
    return res.status(200).json({ conversation: rows || [] });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const action = body.action;

  try {
    // ---- propose ----------------------------------------------------------
    if (action === 'propose') {
      const loaded = await loadComposition(body.compositionId, tenantId);
      if (!loaded) return res.status(404).json({ error: 'Composition not found' });
      const { comp, version, doc } = loaded;

      const instruction = normalizeInstruction(body.instruction);
      if (!instruction) return res.status(400).json({ error: 'An instruction is required' });
      const target = resolveTarget(doc, body.target || {});
      if (target.error) return res.status(409).json({ error: target.error });
      const breakpoint = normalizeBreakpointScope(body.breakpoint);

      let result;
      if (body.resolvedDestination) {
        // Link workflow step 2: the user picked an exact destination —
        // deterministic patch, no LLM involved.
        const elementId = String(body.linkElementId || (target.type === 'element' ? target.elementId : '') || '');
        if (!elementId) return res.status(400).json({ error: 'linkElementId required' });
        if (!(await verifyDestination(tenantId, body.resolvedDestination))) {
          return res.status(422).json({ error: 'That destination could not be found in this organisation.' });
        }
        const op = buildDestinationLinkOp(elementId, body.resolvedDestination);
        const applied = applyPatch(doc, [op]);
        if (!applied.ok) return res.status(422).json({ error: 'The link could not be applied.', details: applied.errors.slice(0, 5) });
        result = {
          kind: 'patch',
          summary: `Linked to ${body.resolvedDestination.title || body.resolvedDestination.kind}.`,
          ops: [op],
          doc: applied.doc,
          protectedViolations: diffProtectedValues(doc, applied.doc),
          isAlternative: false,
        };
      } else {
        const client = getOpenAIClient();
        if (!client) return res.status(503).json({ error: 'AI editing is not configured on this server.' });
        const brand = await buildBrandContext(tenantId);
        result = await runEditProposal({
          callLlm: makeCallLlm(client), doc, instruction, target, breakpoint, brand,
        });
      }

      // Link workflow step 1: pick a destination.
      if (result.kind === 'link_request') {
        const candidates = await searchDestinations(tenantId, result.query);
        return res.status(200).json({
          status: 'needs_destination',
          summary: result.summary,
          elementId: result.elementId,
          query: result.query,
          candidates,
        });
      }

      // Image workflow step 1: hand the structured brief back to the client,
      // which calls /api/ai-compositions/images to actually generate.
      if (result.kind === 'image_request') {
        return res.status(200).json({
          status: 'needs_image',
          summary: result.summary,
          elementId: result.elementId,
          brief: result.brief,
        });
      }

      // Breakpoint isolation double-check at the endpoint boundary.
      const bpViolations = checkBreakpointIsolation(doc, result.doc, breakpoint);
      if (bpViolations.length) {
        return res.status(422).json({ error: 'The change leaked outside the selected breakpoint and was rejected.', details: bpViolations });
      }
      const brokenLinks = await findBrokenLinks(result.doc, tenantId);
      if (brokenLinks.length) {
        return res.status(422).json({
          error: 'The proposed change references links that do not exist in this organisation.',
          brokenLinks,
        });
      }

      const warnings = (result.protectedViolations || []).map((v) => ({
        type: 'protected_value',
        elementId: v.elementId,
        path: v.path,
        label: v.label || v.kind,
        before: v.before,
        after: v.after,
        reason: v.reason,
      }));

      const { data: row, error: insErr } = await supabase
        .from('ai_composition_conversation')
        .insert({
          tenant_id: tenantId,
          composition_id: comp.id,
          base_version_id: version.id,
          instruction,
          target,
          breakpoint,
          kind: result.kind,
          summary: result.summary,
          proposal: result.kind === 'composition_redesign'
            ? { document: result.doc }
            : { ops: result.ops },
          warnings: warnings.length ? warnings : null,
          status: 'proposed',
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (insErr) return res.status(500).json({ error: 'Failed to save the proposal' });

      return res.status(200).json({
        status: 'proposed',
        conversationId: row.id,
        kind: result.kind,
        summary: result.summary,
        isAlternative: !!result.isAlternative,
        warnings,
        previewDocument: result.doc,
      });
    }

    // ---- accept -----------------------------------------------------------
    if (action === 'accept') {
      const { data: row } = await supabase
        .from('ai_composition_conversation')
        .select('*')
        .eq('id', body.conversationId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!row) return res.status(404).json({ error: 'Proposal not found' });
      if (row.status !== 'proposed') return res.status(409).json({ error: 'This proposal was already resolved.' });

      const loaded = await loadComposition(row.composition_id, tenantId);
      if (!loaded) return res.status(404).json({ error: 'Composition not found' });
      const { comp, version, doc } = loaded;

      // Re-derive the accepted document from the STORED proposal against the
      // CURRENT document (never trust a client-sent document), with all
      // accept-time invariants — staleness and FRESH protected-value diffs —
      // recomputed in assessAccept.
      const gate = assessAccept({
        kind: row.kind,
        proposal: row.proposal,
        baseVersionId: row.base_version_id,
        currentVersionId: comp.current_version_id,
        currentDoc: doc,
        confirmProtected: !!body.confirmProtected,
      });
      if (!gate.ok) {
        return res.status(gate.status).json({
          error: gate.error,
          details: gate.details || undefined,
          warnings: gate.warnings || undefined,
          requiresConfirmation: gate.requiresConfirmation || undefined,
        });
      }
      const nextDoc = gate.doc;

      const isAlternative = row.kind === 'composition_redesign';
      const { data: inserted, error: insErr } = await supabase
        .from('ai_composition_version')
        .insert({
          composition_id: comp.id,
          tenant_id: tenantId,
          parent_version_id: version.id,
          document: nextDoc,
          change_summary: row.summary || row.instruction.slice(0, 200),
          operation_type: isAlternative ? 'redesign' : 'edit',
          is_alternative: isAlternative,
          validation_result: { ok: true },
          generation_metadata: { conversationId: row.id, kind: row.kind, breakpoint: row.breakpoint },
          created_by: context.memberId || null,
        })
        .select('id')
        .single();
      if (insErr) return res.status(500).json({ error: 'Failed to save the new version' });

      // Alternatives are kept side by side; the user switches explicitly.
      if (!isAlternative) {
        await supabase
          .from('ai_composition')
          .update({ current_version_id: inserted.id, updated_at: new Date().toISOString() })
          .eq('id', comp.id)
          .eq('tenant_id', tenantId);
      }

      await supabase
        .from('ai_composition_conversation')
        .update({ status: 'accepted', version_id: inserted.id, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('tenant_id', tenantId);

      return res.status(200).json({
        status: 'accepted',
        versionId: inserted.id,
        isAlternative,
        currentVersionId: isAlternative ? version.id : inserted.id,
      });
    }

    // ---- reject -----------------------------------------------------------
    if (action === 'reject') {
      const { data: row } = await supabase
        .from('ai_composition_conversation')
        .select('id, status')
        .eq('id', body.conversationId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!row) return res.status(404).json({ error: 'Proposal not found' });
      await supabase
        .from('ai_composition_conversation')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('tenant_id', tenantId);
      return res.status(200).json({ status: 'rejected' });
    }

    // ---- undo -------------------------------------------------------------
    if (action === 'undo') {
      const loaded = await loadComposition(body.compositionId, tenantId);
      if (!loaded) return res.status(404).json({ error: 'Composition not found' });
      const { comp, version } = loaded;
      if (!version.parent_version_id) {
        return res.status(409).json({ error: 'Nothing to undo — this is the first version.' });
      }
      const { data: parent } = await supabase
        .from('ai_composition_version')
        .select('id')
        .eq('id', version.parent_version_id)
        .eq('composition_id', comp.id)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!parent) return res.status(409).json({ error: 'The previous version no longer exists.' });
      await supabase
        .from('ai_composition')
        .update({ current_version_id: parent.id, updated_at: new Date().toISOString() })
        .eq('id', comp.id)
        .eq('tenant_id', tenantId);
      return res.status(200).json({ status: 'undone', currentVersionId: parent.id });
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (err) {
    const status = err.httpStatus === 502 ? 502 : (err.httpStatus || 500);
    return res.status(status).json({
      error: err.message || 'Edit failed',
      validationErrors: err.validationErrors || undefined,
    });
  }
}
