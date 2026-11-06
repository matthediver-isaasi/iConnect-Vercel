import { cloneElement, createContext, useContext, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export const MembershipPrimaryActionContext = createContext(null);

export function membershipReadyToSubmit(value) {
  return ['paid', 'already_paid'].includes(value?.status)
    || Boolean(value?.voucherCheckoutId && value?.agreementId
      && ['direct_debit_started', 'monthly_card_started'].includes(value.status));
}

// Move the existing payment action, rather than creating a second payment
// implementation in the form footer. Standalone renderers retain their button.
export default function MembershipPrimaryAction({ children, active = true, secondary = false }) {
  const context = useContext(MembershipPrimaryActionContext);
  const id = useId();
  const running = useRef(false);
  const register = context?.register;
  useEffect(() => {
    if (secondary || !active || !register || !context?.target) return;
    register(id, true);
    return () => register(id, false);
  }, [active, secondary, register, id, context?.target]);
  if (!active) return null;
  if (!context) return children;
  const target = secondary ? context.backTarget : context.target;
  if (!target) return children;
  return createPortal(cloneElement(children, {
    className: secondary ? 'w-full sm:w-auto' : 'bg-black text-white hover:bg-black/90 w-full sm:w-auto',
    type: 'button',
    disabled: children.props.disabled || (!secondary && context.blocked),
    onClick: async event => {
      event.preventDefault();
      if (running.current || children.props.disabled || (!secondary && context.blocked)) return;
      running.current = true;
      try {
        if (secondary || await context.validate()) await children.props.onClick?.(event);
      } finally {
        running.current = false;
      }
    },
  }), target);
}
