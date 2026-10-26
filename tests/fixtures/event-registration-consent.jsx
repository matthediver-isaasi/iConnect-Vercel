import React from 'react';
import '../../client/src/index.css';
import { createRoot } from 'react-dom/client';
import { offerEventRegistrationConsent, cancelEventRegistrationConsent } from '../../client/src/components/booking/EventRegistrationConsent';
import EventRegistrationCommunication from '../../client/src/components/events/EventRegistrationCommunication';
const context = { eventId: 'event', memberId: 'member' };
window.showOffer = (result) => offerEventRegistrationConsent(result, context);
window.switchIdentity = () => cancelEventRegistrationConsent(context);
function Fixture() {
  const [ids, setIds] = React.useState(null);
  return <main><h1>Registration confirmed</h1><a href="#confirmation">View confirmation</a>
    <EventRegistrationCommunication eventId="event" kind="simple" value={ids} onChange={setIds}/>
    <output data-testid="selected">{JSON.stringify(ids)}</output>
  </main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
