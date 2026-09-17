import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';

// Current-set editing is deliberately opt-in.  The endpoint is an
// authorization boundary, not a generic custom-object prefill endpoint.
export const DEPARTMENT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function currentSetDepartmentId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return DEPARTMENT_UUID_PATTERN.test(id) ? id : null;
}

export function isDepartmentCurrentSetForm(form) {
  return form?.current_set_enabled === true;
}

export function currentSetSectionIds(form, payload = {}) {
  const config = payload?.configuration || payload?.config || form?.current_set_configuration
    || form?.current_set_config || {};
  const workforce = config.workforce_field_id || config.workforce_container_field_id || config.workforceFieldId
    || config.workforce?.field_id || config.workforce?.fieldId;
  const equipment = config.equipment_field_id || config.equipment_container_field_id || config.equipmentFieldId
    || config.equipment?.field_id || config.equipment?.fieldId;
  return {
    workforce: workforce || null,
    equipment: equipment || null,
  };
}

function completeSection(value) {
  const section = Array.isArray(value) ? { rows: value } : (value || {});
  const rows = section.rows ?? section.values ?? section.data;
  return {
    rows: Array.isArray(rows) ? rows : null,
    complete: section.complete === true,
    legacy: section.legacy === true || section.has_legacy_values === true,
  };
}

export function normalizeDepartmentCurrentSet(payload) {
  const source = payload?.current_set || payload || {};
  const formValues = source.form_values || source.formValues || {};
  const metadata = formValues.__department_current_set || source.__department_current_set || {};
  const completeSections = source.complete_sections || metadata.complete_sections || [];
  const workforce = completeSection(source.workforce);
  const equipment = completeSection(source.equipment);
  return {
    department: source.department || payload?.department
      || (source.department_id ? { id: source.department_id } : null),
    version: metadata.version || source.version || source.current_set_version || payload?.version || null,
    configVersion: source.configuration_version || source.config_version
      || payload?.configuration_version || payload?.config_version || null,
    workforce,
    equipment,
    formValues,
    completeSections: Array.isArray(completeSections) ? completeSections : [],
    configuration: source.configuration || payload?.configuration || payload?.config || null,
    optionLabels: source.option_labels || source.optionLabels || payload?.option_labels
      || payload?.optionLabels || {},
  };
}

export function mergeDepartmentCurrentSetValues({
  formValues,
  sectionIds,
  currentSet,
}) {
  const next = { ...(formValues || {}) };
  // Never overwrite a restored draft, transition answer, or a respondent edit.
  // An empty array is a deliberate answer and is therefore also preserved.
  for (const [name, section] of Object.entries(sectionIds || {})) {
    if (!section) continue;
    if (Object.prototype.hasOwnProperty.call(next, section)) continue;
    if (Array.isArray(currentSet?.[name]?.rows)) {
      next[section] = currentSet[name].rows;
    }
  }
  // Draft persistence must carry the trusted version/context, otherwise a
  // resumed current-set draft cannot be distinguished from a new destructive
  // submission. Do not replace a draft's existing context here.
  if (!Object.prototype.hasOwnProperty.call(next, '__department_current_set')
      && currentSet?.formValues?.__department_current_set
      && typeof currentSet.formValues.__department_current_set === 'object') {
    next.__department_current_set = currentSet.formValues.__department_current_set;
  }
  return next;
}

function clearDepartmentCurrentSetValues(formValues, sectionIds) {
  const next = { ...(formValues || {}) };
  for (const id of Object.values(sectionIds || {})) {
    if (id) delete next[id];
  }
  delete next.__department_current_set;
  return next;
}

export function currentSetSubmissionMetadata({
  form,
  departmentId,
  currentSet,
  acknowledgements,
}) {
  if (!isDepartmentCurrentSetForm(form)) return null;
  if (!departmentId || !currentSet?.version) return null;
  return {
    department_id: departmentId,
    version: currentSet.version,
    complete_sections: [
      ...(currentSet.completeSections || []),
    ],
  };
}

export function currentSetSaveBlocked({
  enabled,
  departmentId,
  loading,
  error,
  currentSet,
  sectionIds,
  acknowledgements,
  baselineReady = true,
}) {
  if (!enabled) return null;
  if (!departmentId) return 'A valid Department link is required to update current data.';
  if (loading) return 'Current Department data is still loading.';
  if (error) return error?.message || 'Current Department data could not be loaded. Reload before saving.';
  if (!baselineReady) return 'Current Department data has not been safely applied. Reload before saving.';
  if (!currentSet?.version || !sectionIds?.workforce || !sectionIds?.equipment) {
    return 'Current Department data is incomplete or no longer matches this form. Reload before saving.';
  }
  if (!currentSet.workforce.complete || !currentSet.equipment.complete) {
    return 'Current Department data was only partially loaded. Reload before saving.';
  }
  if (acknowledgements?.workforce !== true || acknowledgements?.equipment !== true) {
    return 'Review and acknowledge both complete sections before saving current Department data.';
  }
  return null;
}

export function currentSetCommitConfirmed(result) {
  const currentSet = result?.current_set || result?.currentSet || result?.processing?.current_set;
  return ['committed', 'replayed'].includes(currentSet?.status)
    && typeof currentSet?.version === 'string' && currentSet.version.length > 0;
}

export function useDepartmentCurrentSet({
  form,
  departmentId,
  principalId = null,
  formValues,
  setFormValues,
  enabled = true,
  ready = true,
  onDepartmentSelect = null,
}) {
  const active = enabled && isDepartmentCurrentSetForm(form);
  const [acknowledgements, setAcknowledgements] = useState({ workforce: false, equipment: false });
  const [baseline, setBaseline] = useState(null);
  const appliedRef = useRef('');
  const dirtyRef = useRef(false);
  const principalRef = useRef({ initialized: false, value: principalId });
  const safeDepartmentId = currentSetDepartmentId(departmentId);
  const principalChanged = principalRef.current.initialized
    && principalRef.current.value !== principalId;
  const query = useQuery({
    queryKey: ['department-current-set', form?.id, safeDepartmentId, principalId || 'anonymous'],
    queryFn: () => publicClient.getDepartmentCurrentSet(form?.slug, form?.id, safeDepartmentId),
    enabled: active && ready && !!safeDepartmentId && !!principalId,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const optionsQuery = useQuery({
    queryKey: ['department-current-set-options', form?.id, principalId || 'anonymous'],
    queryFn: () => publicClient.getDepartmentCurrentSetOptions(form?.id),
    enabled: active && ready && !!principalId && !safeDepartmentId,
    retry: false,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const departmentOptions = useMemo(() => {
    const options = optionsQuery.data?.departments || optionsQuery.data || [];
    return Array.isArray(options) ? options.filter(option => currentSetDepartmentId(option?.id)) : [];
  }, [optionsQuery.data]);
  const queriedCurrentSet = useMemo(() => normalizeDepartmentCurrentSet(query.data), [query.data]);
  const draftMetadata = formValues?.__department_current_set;
  const staleDraft = !!draftMetadata && typeof draftMetadata === 'object'
    && !!queriedCurrentSet.version
    && (draftMetadata.department_id !== safeDepartmentId
      || draftMetadata.version !== queriedCurrentSet.version);
  const currentSet = principalChanged ? queriedCurrentSet : (baseline || queriedCurrentSet);
  const configuredSectionIds = useMemo(() => currentSetSectionIds(form), [form]);
  const sectionIds = useMemo(() => currentSetSectionIds(form, {
    configuration: currentSet.configuration,
  }), [form, currentSet.configuration]);
  const resolvedCurrentSet = useMemo(() => ({
    ...currentSet,
    workforce: {
      ...currentSet.workforce,
      rows: Array.isArray(currentSet.formValues?.[sectionIds.workforce])
        ? currentSet.formValues[sectionIds.workforce] : currentSet.workforce.rows,
      complete: Array.isArray(currentSet.formValues?.[sectionIds.workforce])
        && (currentSet.completeSections.includes(sectionIds.workforce) || currentSet.workforce.complete),
    },
    equipment: {
      ...currentSet.equipment,
      rows: Array.isArray(currentSet.formValues?.[sectionIds.equipment])
        ? currentSet.formValues[sectionIds.equipment] : currentSet.equipment.rows,
      complete: Array.isArray(currentSet.formValues?.[sectionIds.equipment])
        && (currentSet.completeSections.includes(sectionIds.equipment) || currentSet.equipment.complete),
    },
  }), [currentSet, sectionIds.equipment, sectionIds.workforce]);
  const identity = `${form?.id || ''}:${safeDepartmentId || ''}:${resolvedCurrentSet.version || ''}`;

  const resetScopedState = useCallback(() => {
    appliedRef.current = '';
    dirtyRef.current = false;
    setBaseline(null);
    setAcknowledgements({ workforce: false, equipment: false });
  }, []);

  useLayoutEffect(() => {
    const previous = principalRef.current;
    const changed = previous.initialized && previous.value !== principalId;
    principalRef.current = { initialized: true, value: principalId };
    resetScopedState();
    if (changed) {
      setFormValues(previousValues => clearDepartmentCurrentSetValues(
        previousValues,
        configuredSectionIds,
      ));
    }
  }, [configuredSectionIds, form?.id, principalId, resetScopedState, safeDepartmentId, setFormValues]);

  useEffect(() => {
    appliedRef.current = '';
    dirtyRef.current = false;
    setBaseline(null);
    setAcknowledgements({ workforce: false, equipment: false });
  }, [form?.id, safeDepartmentId]);

  const selectDepartment = useCallback((nextDepartmentId) => {
    const nextId = currentSetDepartmentId(nextDepartmentId);
    if (!nextId || nextId === safeDepartmentId) return;
    const ids = {
      workforce: sectionIds.workforce || configuredSectionIds.workforce,
      equipment: sectionIds.equipment || configuredSectionIds.equipment,
    };
    const hasScopedEdits = Object.values(ids).some(id => {
      if (!id) return false;
      const currentRows = formValues?.[id];
      const baselineRows = baseline?.formValues?.[id];
      return baseline
        ? JSON.stringify(currentRows) !== JSON.stringify(baselineRows)
        : Array.isArray(currentRows) && currentRows.length > 0;
    });
    if (hasScopedEdits && typeof window !== 'undefined' && typeof window.confirm === 'function'
        && !window.confirm('Changing Department will discard the current Workforce and Equipment answers. Continue?')) {
      return;
    }
    setFormValues(previousValues => clearDepartmentCurrentSetValues(previousValues, ids));
    resetScopedState();
    onDepartmentSelect?.(nextId);
  }, [
    baseline, configuredSectionIds.equipment, configuredSectionIds.workforce, formValues,
    onDepartmentSelect, resetScopedState, safeDepartmentId, sectionIds.equipment,
    sectionIds.workforce, setFormValues,
  ]);

  useEffect(() => {
    if (!active || !ready || !principalId || principalChanged || query.isLoading || query.isError || baseline || staleDraft || !queriedCurrentSet.version
      || appliedRef.current === identity || dirtyRef.current) return;
    const initial = {
      ...queriedCurrentSet,
      workforce: {
        ...queriedCurrentSet.workforce,
        rows: Array.isArray(queriedCurrentSet.formValues?.[sectionIds.workforce])
          ? queriedCurrentSet.formValues[sectionIds.workforce] : queriedCurrentSet.workforce.rows,
        complete: Array.isArray(queriedCurrentSet.formValues?.[sectionIds.workforce])
          && (queriedCurrentSet.completeSections.includes(sectionIds.workforce) || queriedCurrentSet.workforce.complete),
      },
      equipment: {
        ...queriedCurrentSet.equipment,
        rows: Array.isArray(queriedCurrentSet.formValues?.[sectionIds.equipment])
          ? queriedCurrentSet.formValues[sectionIds.equipment] : queriedCurrentSet.equipment.rows,
        complete: Array.isArray(queriedCurrentSet.formValues?.[sectionIds.equipment])
          && (queriedCurrentSet.completeSections.includes(sectionIds.equipment) || queriedCurrentSet.equipment.complete),
      },
    };
    if (!initial.workforce.complete || !initial.equipment.complete) return;
    setFormValues(previous => mergeDepartmentCurrentSetValues({
      formValues: previous,
      sectionIds,
      currentSet: initial,
    }));
    setBaseline(queriedCurrentSet);
    appliedRef.current = `${form?.id || ''}:${safeDepartmentId || ''}:${queriedCurrentSet.version || ''}`;
  }, [active, baseline, form?.id, principalChanged, principalId, queriedCurrentSet, query.isError, query.isLoading, ready, safeDepartmentId, sectionIds, setFormValues, staleDraft]);

  const versionChanged = !!baseline && !!queriedCurrentSet.version
    && baseline.version !== queriedCurrentSet.version;
  const existingBlankRequiredFieldsByRow = useMemo(() => {
    const ids = form?.current_set_configuration?.equipment_existing_blank_required_field_ids;
    if (!Array.isArray(ids) || !baseline || !sectionIds.equipment) return {};
    return Object.fromEntries((baseline.formValues?.[sectionIds.equipment] || [])
      .filter(row => typeof row?._row_id === 'string')
      .map(row => [row._row_id, ids.filter(id => (
        !Object.prototype.hasOwnProperty.call(row, id)
        || row[id] === null || row[id] === ''
      ))])
      .filter(([, blankIds]) => blankIds.length));
  }, [baseline, form?.current_set_configuration?.equipment_existing_blank_required_field_ids, sectionIds.equipment]);

  return {
    active,
    departmentId: safeDepartmentId,
    currentSet: resolvedCurrentSet,
    sectionIds,
    loading: query.isLoading,
    optionsLoading: optionsQuery.isLoading,
    departmentOptions,
    selectDepartment,
    error: staleDraft
      ? new Error('This saved Department draft is stale. Reload and review the current data before saving.')
      : versionChanged
      ? new Error('Current Department data changed. Reload and review before saving.')
      : query.error || optionsQuery.error,
    acknowledgements,
    setAcknowledgements,
    baselineReady: !!baseline,
    existingBlankRequiredFieldsByRow,
    markEdited: () => { dirtyRef.current = true; },
  };
}