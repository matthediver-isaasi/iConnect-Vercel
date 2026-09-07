import { useEffect, useRef, useState } from 'react';
import { publicClient } from '@/api/publicClient';
import { firstMatchingOpenFormAction } from './formOpenTransition';
import { MAX_FORM_TRANSITIONS } from '../../../shared/formOpenTransition.js';

export function useFormOpenTransition({
  initialForm,
  formValues,
  conditionValues = formValues,
  assignmentToken = null,
  authenticated = false,
  enabled = true,
}) {
  const [activeForm, setActiveForm] = useState(initialForm || null);
  const [initialValues, setInitialValues] = useState({});
  const [error, setError] = useState(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const rootIdRef = useRef(null);
  const visitedRef = useRef(new Set());
  const firedRef = useRef(new Set());
  const requestRef = useRef(0);
  const awaitingResetRef = useRef(null);

  useEffect(() => {
    const rootId = initialForm?.id || null;
    if (rootId === rootIdRef.current) return;
    rootIdRef.current = rootId;
    visitedRef.current = new Set(rootId ? [String(rootId)] : []);
    firedRef.current = new Set();
    awaitingResetRef.current = null;
    setActiveForm(initialForm || null);
    setInitialValues({});
    setError(null);
    setIsTransitioning(false);
    requestRef.current += 1;
  }, [initialForm?.id]);

  useEffect(() => {
    if (!enabled || !activeForm?.id || isTransitioning || error) return;
    if (awaitingResetRef.current === String(activeForm.id)) {
      awaitingResetRef.current = null;
      return;
    }
    const action = firstMatchingOpenFormAction(activeForm, conditionValues);
    if (!action) return;
    const actionKey = `${activeForm.id}:${action.id}`;
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
        visitedRef.current.add(String(target.id));
        awaitingResetRef.current = String(target.id);
        setInitialValues(resolved.mapped_values || {});
        setActiveForm(target);
      } catch (transitionError) {
        if (requestRef.current !== requestId) return;
        setError(transitionError?.message || 'The destination form could not be opened.');
      } finally {
        if (requestRef.current === requestId) setIsTransitioning(false);
      }
    })();
  }, [activeForm, assignmentToken, authenticated, conditionValues, enabled, error, formValues, isTransitioning]);

  return {
    activeForm: activeForm || initialForm || null,
    initialValues,
    isTransitioning,
    transitionError: error,
  };
}