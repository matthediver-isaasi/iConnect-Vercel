import { useState } from 'react';
import { parseEventCodeOfConduct, codeOfConductScope, codeOfConductPayload } from '@/lib/eventCodeOfConduct.mjs';

export function useEventCodeOfConduct(settings, eventId, ready = true) {
  const policy = parseEventCodeOfConduct(settings);
  const scope = codeOfConductScope(eventId, policy);
  const [acceptance, setAcceptance] = useState({ scope, accepted: false });
  if (acceptance.scope !== scope) setAcceptance({ scope, accepted: false });
  const accepted = acceptance.scope === scope && acceptance.accepted;
  return {
    ...policy,
    accepted,
    canProceed: ready && (!policy.required || accepted),
    setAccepted: value => setAcceptance({ scope, accepted: value === true }),
    payload: codeOfConductPayload(policy, accepted),
  };
}
