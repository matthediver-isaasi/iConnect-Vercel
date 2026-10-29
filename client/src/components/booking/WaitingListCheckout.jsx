import { useRef, useState } from "react";
import { useEventCodeOfConduct } from "@/hooks/useEventCodeOfConduct";
import CodeOfConductAcceptance from "./CodeOfConductAcceptance";
import { Link } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useEventLogin } from "@/components/auth/useEventLogin";
import { waitingListRequest } from "@/hooks/useEventWaitingList";
import { WAITING_LIST_MESSAGE, waitingListAttendee, resolveWaitingListAttempt } from "@/lib/eventWaitingList.mjs";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { requireAttendeeJobTitle } from "../../../../shared/attendeeJobTitleRequirement.js";
import { publicClient } from "@/api/publicClient";
import { useQuery } from "@tanstack/react-query";

export default function WaitingListCheckout({ event, memberInfo, attendees = [], selectedTicketClass, isComplexEvent = false, complexEventApi, waitingListItems, ticketSelectionUnavailable = false, isRegistrationClosed, hasBookingTerms, termsAccepted, setTermsAccepted, onShowTermsModal, collectThirdPartyConsent = false, thirdPartyConsent = false, setThirdPartyConsent, renderAsCard = true, editorMode = false }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const attempt = useRef(null);
  const busy = useRef(false);
  const queryClient = useQueryClient();
  const { openLogin, loginModal } = useEventLogin();
  const { authResolved, sessionValidated, roleStatus } = useMemberAccess();
  const { data: settings, isLoading: settingsLoading, isError: settingsError, refetch } = useQuery({
    queryKey: ['public-system-settings'], queryFn: () => publicClient.listSystemSettings(),
  });
  const signedIn = !!memberInfo?.id && authResolved && sessionValidated && roleStatus === 'ready';
  const codeOfConduct = useEventCodeOfConduct(settings, event?.id, !settingsLoading && !settingsError);
  const items = isComplexEvent ? (waitingListItems || complexEventApi?._getCartItems?.() || []) : [{
    ticket_class_id: selectedTicketClass?.id || event?.ticket_classes?.[0]?.id || 'default',
    attendees,
  }];
  const normalized = items.flatMap(item => (item.attendees || []).map(attendee =>
    waitingListAttendee(attendee, item.ticket_class_id, item.session_ids || [])));
  const invalid = !normalized.length || normalized.some(a => !a.first_name || !a.last_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)
    || !a.ticket_class_id || (requireAttendeeJobTitle(settings) && !a.job_title));
  const blocked = !codeOfConduct.canProceed || invalid || ticketSelectionUnavailable || isRegistrationClosed || (hasBookingTerms && !termsAccepted);
  async function join() {
    if (busy.current || blocked || !signedIn || settingsLoading || settingsError || editorMode) return;
    busy.current = true;
    setPending(true);
    setError('');
    const payload = { event_id: event.id, event_kind: isComplexEvent ? 'complex' : 'simple', attendees: normalized,
      ...codeOfConduct.payload,
      third_party_consent: collectThirdPartyConsent ? thirdPartyConsent === true : null };
    attempt.current = resolveWaitingListAttempt(attempt.current, { tenant: memberInfo.tenant_id, member: memberInfo.id, payload }, uuidv4);
    try {
      await waitingListRequest('/api/member/event-waiting-list', {
        method: 'POST', body: JSON.stringify({ ...payload, idempotency_key: attempt.current.key }),
      }, memberInfo.tenant_id);
      setComplete(true);
      queryClient.invalidateQueries({ queryKey: ['event-waiting-list'] });
    } catch (err) { setError(err.message); }
    finally { busy.current = false; setPending(false); }
  }
  const content = complete ? <div role="status" className="space-y-3">
    <h3 className="font-semibold text-lg">You're on the waiting list!</h3>
    <p className="text-sm text-slate-600">Thanks for your interest. We'll keep you informed as more information becomes available. This is not a confirmed booking.</p>
    <Link className="text-sm font-medium text-blue-700 underline" to="/waitingList">View or remove entries in My Waiting Lists</Link>
  </div> : <div className="space-y-4">
    <p className="text-sm text-slate-600">{WAITING_LIST_MESSAGE}</p>
    <p className="text-xs text-slate-500">Displayed prices are advertised prices, not an amount due. Your ticket and session preferences will be saved.</p>
    {hasBookingTerms && <label className="flex gap-2 items-start text-sm"><Checkbox checked={termsAccepted} onCheckedChange={setTermsAccepted} /><span>I accept the <button type="button" className="underline text-blue-700" onClick={onShowTermsModal}>terms and conditions</button>.</span></label>}
    <CodeOfConductAcceptance policy={codeOfConduct} />
    {collectThirdPartyConsent && <label className="flex gap-2 items-start text-sm"><Checkbox checked={thirdPartyConsent} onCheckedChange={setThirdPartyConsent} /><span>I consent to my name, organisation, email and job title being shared with relevant third-party suppliers in connection with this event.</span></label>}
    {settingsLoading && <div className="h-8 rounded bg-slate-100 animate-pulse" aria-label="Loading registration settings" />}
    {settingsError && <div role="alert" className="text-sm text-red-700">Unable to load registration settings. <button className="underline" onClick={() => refetch()}>Retry</button></div>}
    {error && <p role="alert" className="text-sm text-red-700">{error} Retry safely using the same action below.</p>}
    {!signedIn ? <Button type="button" className="w-full" onClick={openLogin}>Log in to join the waiting list</Button> : <>
      {invalid && <p className="text-xs text-slate-500">Select a ticket and add complete attendee details to continue.</p>}
      <Button type="button" data-testid="button-join-waiting-list" className="w-full" onClick={join} disabled={blocked || pending || settingsLoading || settingsError || editorMode}>{pending ? 'Adding to waiting list…' : 'Add me to the waiting list'}</Button>
    </>}
  </div>;
  return <>{renderAsCard ? <Card className="border-slate-200"><CardHeader><CardTitle>Join the waiting list</CardTitle></CardHeader><CardContent>{content}</CardContent></Card> : content}{loginModal}</>;
}
