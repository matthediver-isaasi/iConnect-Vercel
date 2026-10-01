const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const owns = (object, key) => key != null && Object.prototype.hasOwnProperty.call(object || {}, key);

export function hasGroupInitialSelection(field) {
  return field?.type === 'organisation_group_dropdown'
    && ['specific', 'url'].includes(field.group_initial_selection?.mode);
}

export function groupInitialSelectionCandidate(field, search = '') {
  if (!hasGroupInitialSelection(field)) return null;
  const config = field.group_initial_selection;
  let candidate = config.group_id;
  if (config.mode === 'url') {
    // The parameter is deliberately fixed, not configurable by a field name.
    const params = new URLSearchParams(search);
    const values = params.getAll('group_id');
    if (values.length !== 1) return null;
    candidate = values[0];
  }
  return typeof candidate === 'string' && UUID.test(candidate) ? candidate.toLowerCase() : null;
}

export function hasGroupInitialSelectionAnswer(field, values, value) {
  // Presence, not truthiness: null, '', [], and legacy name-keyed blanks are
  // answers too. An explicitly present undefined value must also be retained.
  return value !== undefined || owns(values, field?.id) || owns(values, field?.name);
}

export function resolveGroupInitialSelection({
  field, values, value, search, ready, optionsLoaded, optionsError,
  conditionalResolution, options = [], disabled = false, optionIsAvailable = () => true,
}) {
  // An author lock prevents respondent edits, not configured initialization.
  // Surface/read-only disablement remains a separate, fail-closed gate.
  if (!ready || disabled || field?.read_only || field?.display_only
    || hasGroupInitialSelectionAnswer(field, values, value)
    || !optionsLoaded || optionsError
    || conditionalResolution?.valid === false) return null;
  const candidate = groupInitialSelectionCandidate(field, search);
  if (!candidate) return null;
  // These are the tenant-scoped, allowed AND conditionally intersected options,
  // never a by-ID lookup or a trusted historical-label fallback.
  const option = options.find(item => String(item?.id).toLowerCase() === candidate);
  return option && optionIsAvailable(option.id) ? option.id : null;
}

export function groupInitialSelectionSurfaceReady({
  form, initialized, initializedFormId, authResolved, draftToken = null,
  draftLoaded = false, prefillExpected = false, prefillApplied = false,
  currentSetPending = false, blocked = false,
}) {
  return Boolean(form?.id && initialized && String(initializedFormId) === String(form.id)
    && authResolved && !blocked && !currentSetPending
    && (!draftToken || draftLoaded) && (!prefillExpected || prefillApplied));
}

export function repeatableGroupInitialCellEntries(child, row = {}) {
  if (!hasGroupInitialSelection(child)) return null;
  if (owns(row, child.id)) return [[child.id, row[child.id]]];
  if (owns(row, child.name)) return [[child.id, row[child.name]]];
  // Do not manufacture a blank answer before a new row's initial selection
  // can run. Persisted/user-cleared blanks above remain explicit.
  if (child.default_value === undefined) return [];
  return [[child.id, child.default_value]];
}