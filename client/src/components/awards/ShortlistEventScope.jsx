import { useEffect, useRef } from 'react';
import { eventLinksReady, usePublicationEventLinks } from './usePublicationEventLinks';
import PublicationEventScope from './PublicationEventScope';

export default function ShortlistEventScope({ tenant, award, scope, eventLinkId, historicalStream, disabled, onChange, onVerified }) {
  const links = usePublicationEventLinks(tenant, award.id, scope === 'event');
  const callbacks = useRef({ onVerified }); callbacks.current = { onVerified };
  const verified = eventLinksReady(links) && links.data.some(row => row.id === eventLinkId);
  useEffect(() => { callbacks.current.onVerified(verified ? eventLinkId : null); }, [verified, eventLinkId]);
  return <PublicationEventScope query={links} scope={scope} eventLinkId={eventLinkId} disabled={disabled} onChange={onChange}
    historicalIds={historicalStream && eventLinkId ? [eventLinkId] : []} />;
}
