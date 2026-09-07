import { useCallback, useEffect, useRef, useState } from 'react';
import { publicClient } from '@/api/publicClient';
import {
  firstMatchingOpenFormTransition,
  openFormTriggerFieldIds,
} from './formOpenTransition';
import { MAX_FORM_TRANSITIONS } from '../../../shared/formOpenTransition.js';

export function useFormOpenTransition({
  initialForm,
  formValues,
  conditionValues = formValues,
  assignmentToken = null,
  authenticated = false,
  enabled = true,
  navigationPosition = null,
  lastChangedField = null,
}) {
  const [activeForm, setActiveForm] = useState(initialForm || null);
  const [initialValues, setInitialValues] = useState({});
  const [restoreNavigation, setRestoreNavigation] = useState(null);
  const [historyDepth, setHistoryDepth] = useState(0);
  const [error, setError] = useState(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const rootIdRef = useRef(null);
  const historyRef = useRef([]);
  const visitedRef = useRef(new Set());
  const firedRef = useRef(new Set());
  const suspendedActionRef = useRef(null);
  const returningToRef = useRef(null);
  const requestRef = useRef(0);
  const awaitingResetRef = useRef(null);
  const previousConditionValuesRef = useRef(new Map());
  const observedFieldChangeRevisionRef = useRef(new Map());
  const pendingRespondentFieldRef = useRef(new Map());
  const navigationRef = useRef(navigationPosition);
  navigationRef.current = navigationPosition;

  useEffect(() => {
    const rootId = initialForm?.id || null;
    if (rootId === rootIdRef.current) return;
    rootIdRef.current = rootId;
    historyRef.current = [];
    visitedRef.current = new Set(rootId ? [String(rootId)] : []);
    firedRef.current = new Set();
    suspendedActionRef.current = null;
    returningToRef.current = null;
    awaitingResetRef.current = null;
    previousConditionValuesRef.current = new Map();
    observedFieldChangeRevisionRef.current = new Map();
    pendingRespondentFieldRef.current = new Map();
    setActiveForm(initialForm || null);
    setInitialValues({});
    setRestoreNavigation(null);
    setHistoryDepth(0);
    setError(null);
    setIsTransitioning(false);
    requestRef.current += 1;
  }, [initialForm?.id]);

  const returnToPreviousForm = useCallback(() => {
    if (returningToRef.current) return false;
    const previous = historyRef.current.pop();
    if (!previous) return false;

    returningToRef.current = String(previous.form.id);
    requestRef.current += 1;
    visitedRef.current.delete(String(activeForm?.id || ''));
    firedRef.current.delete(previous.actionKey);
    suspendedActionRef.current = {
      formId: String(previous.form.id),
      actionKey: previous.actionKey,
    };
    awaitingResetRef.current = String(previous.form.id);
    setHistoryDepth(historyRef.current.length);
    const restoredValues = { ...previous.formValues };
    for (const fieldId of previous.triggerFieldIds || []) {
      restoredValues[fieldId] = undefined;
    }
    setInitialValues(restoredValues);
    setRestoreNavigation(previous.navigationPosition);
    setError(null);
    setIsTransitioning(false);
    setActiveForm(previous.form);
    return true;
  }, [activeForm?.id]);

  useEffect(() => {
    if (returningToRef.current === String(activeForm?.id || '')) {
      returningToRef.current = null;
    }
  }, [activeForm?.id]);

  useEffect(() => {
    if (!enabled || !activeForm?.id || isTransitioning || error) return;
    const activeFormId = String(activeForm.id);
    const previousConditionValues = previousConditionValuesRef.current.get(activeFormId) || {};
    previousConditionValuesRef.current.set(activeFormId, { ...(conditionValues || {}) });
    const fieldChangeMatchesForm = String(lastChangedField?.formId || '') === activeFormId;
    const fieldChangeRevision = fieldChangeMatchesForm ? Number(lastChangedField?.revision || 0) : 0;
    const previousObservedRevision = observedFieldChangeRevisionRef.current.get(activeFormId) || 0;
    if (fieldChangeRevision > previousObservedRevision) {
      observedFieldChangeRevisionRef.current.set(activeFormId, fieldChangeRevision);
      pendingRespondentFieldRef.current.set(activeFormId, {
        fieldId: lastChangedField?.fieldId,
        revision: fieldChangeRevision,
      });
    }
    const pendingRespondentField = pendingRespondentFieldRef.current.get(activeFormId);
    const changedByRespondentFieldId = pendingRespondentField?.fieldId || null;
    if (awaitingResetRef.current === String(activeForm.id)) {
      awaitingResetRef.current = null;
      return;
    }
    const match = firstMatchingOpenFormTransition(activeForm, conditionValues);
    const action = match?.action || null;
    const suspended = suspendedActionRef.current;
    if (!action) {
      if (suspended?.formId === activeFormId) suspendedActionRef.current = null;
      return;
    }
    const actionKey = `${activeForm.id}:${action.id}`;
    if (suspended?.formId === activeFormId) {
      if (suspended.actionKey === actionKey) return;
      suspendedActionRef.current = null;
    }
    if (firedRef.current.has(actionKey)) return;
    firedRef.current.add(actionKey);

    if (visitedRef.current.size >= MAX_FORM_TRANSITIONS) {
      setError('This form could not continue because too many form changes were requested.');
      return;
    }

    const requestId = ++requestRef.current;
    setIsTransitioning(true);
    setError(null);
    (async () => {
      try {
        const resolved = await publicClient.resolveFormTransition({
          source_form_id: activeForm.id,
          action_id: action.id,
          answers: formValues,
          condition_answers: conditionValues,
          source_assignment_token: assignmentToken,
        });
        if (requestRef.current !== requestId) return;
        if (!resolved?.target_slug || !resolved?.target_form_id) throw new Error('The destination form is unavailable.');
        if (visitedRef.current.has(String(resolved.target_form_id))) {
          throw new Error('This form could not continue because the form change would create a loop.');
        }
        const target = await publicClient.getForm(resolved.target_slug, { authenticated });
        if (requestRef.current !== requestId) return;
        if (!target?.id || String(target.id) !== String(resolved.target_form_id)) {
          throw new Error('The destination form is unavailable.');
        }
        historyRef.current.push({
          form: activeForm,
          formValues: { ...(formValues || {}) },
          navigationPosition: navigationRef.current
            ? { ...navigationRef.current }
            : null,
          actionKey,
          triggerFieldIds: openFormTriggerFieldIds(
            activeForm,
            conditionValues,
            match.rule,
            previousConditionValues,
            changedByRespondentFieldId,
          ),
        });
        if (pendingRespondentField?.revision ===
          pendingRespondentFieldRef.current.get(activeFormId)?.revision) {
          pendingRespondentFieldRef.current.delete(activeFormId);
        }
        visitedRef.current.add(String(target.id));
        awaitingResetRef.current = String(target.id);
        suspendedActionRef.current = null;
        setHistoryDepth(historyRef.current.length);
        setInitialValues(resolved.mapped_values || {});
        setRestoreNavigation(null);
        setActiveForm(target);
      } catch (transitionError) {
        if (requestRef.current !== requestId) return;
        setError(transitionError?.message || 'The destination form could not be opened.');
      } finally {
        if (requestRef.current === requestId) setIsTransitioning(false);
      }
    })();
  }, [activeForm, assignmentToken, authenticated, conditionValues, enabled, error, formValues, isTransitioning, lastChangedField]);

  return {
    activeForm: activeForm || initialForm || null,
    initialValues,
    restoreNavigation,
    canReturnToPreviousForm: historyDepth > 0,
    returnToPreviousForm,
    isTransitioning,
    transitionError: error,
  };
}