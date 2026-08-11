// Task #3515: card-swipe autofocus gating.
//
// The card-swipe form layout auto-focuses the current card's input. Browsers
// scroll a focused input into view, so autofocusing on INITIAL mount made
// pages that embed a card-swipe form jump straight down to the form on load.
// Focus is genuinely helpful when stepping between cards, so it must stay
// for every step transition — only the first-mount focus goes.
//
// Shared by all three card-swipe render paths (embedded page element,
// standalone form page, iframe embed page) so behaviour never drifts.
import { useRef, useEffect } from 'react';

// Field types whose input should receive focus on a card transition.
export const CARD_SWIPE_AUTOFOCUS_TYPES = ['text', 'email', 'url', 'number', 'tel', 'textarea'];

/**
 * Pure decision: autofocus only after the user has moved between cards
 * (never on the initial mount), and only for typeable field types.
 */
export function shouldAutoFocusCardField({ fieldType, hasNavigated }) {
  return !!hasNavigated && CARD_SWIPE_AUTOFOCUS_TYPES.includes(fieldType);
}

/**
 * Hook: returns an `autoFocusFor(fieldType)` function for the card-swipe
 * layout. `hasNavigated` latches true the first time `currentStep` differs
 * from the step the component mounted with — so returning to the first card
 * later still focuses, but the initial load never does.
 */
export function useCardSwipeAutoFocus(currentStep) {
  const initialStepRef = useRef(currentStep);
  const navigatedRef = useRef(false);
  // hasNavigated = pure render-time derivation OR committed latch:
  //  - `currentStep !== initialStepRef.current` is a pure comparison (no
  //    render-time mutation), so the very first transition's remounted
  //    FormRenderer already sees autofocus=true in the same render.
  //  - The ref latch is written only in an effect — effects run only for
  //    COMMITTED renders, so an abandoned/restarted concurrent render can
  //    never permanently latch a navigation that was never user-visible.
  //    It covers returning to the mount step later (derivation false again).
  useEffect(() => {
    if (currentStep !== initialStepRef.current) navigatedRef.current = true;
  }, [currentStep]);
  return (fieldType) => shouldAutoFocusCardField({
    fieldType,
    hasNavigated: navigatedRef.current || currentStep !== initialStepRef.current,
  });
}
