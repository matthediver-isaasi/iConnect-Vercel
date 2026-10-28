import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMemberChangeSession } from "@/hooks/useMemberChangeSession";
import { memberChangeRequest } from "@/lib/memberChangeRequests";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Optional discovery only: ordinary form fields/settings never grant access.
// Preview and on-behalf-of surfaces may suppress discovery, never enable it.
export default function MemberChangeFormLink({ formId, disabled = false }) {
  const scope = useMemberChangeSession();
  if (disabled || scope.status !== "ready" || !uuid.test(formId || "")) return null;
  return <AvailabilitySession key={`${formId}:${scope.scopeKey}`} formId={formId} scope={scope} />;
}

function AvailabilitySession({ formId, scope }) {
  const [available, setAvailable] = useState(false);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      try {
        liveScope.current.assertCurrent();
        const result = await memberChangeRequest("member_change_availability", formId, {}, controller.signal);
        if (!active) return;
        liveScope.current.assertCurrent();
        setAvailable(result?.available === true);
      } catch {
        // This optional affordance must never block submissions, retry, or
        // start a login redirect. Failure is not an availability grant.
        if (active) setAvailable(false);
      }
    }
    void load();
    return () => { active = false; controller.abort(); };
  }, []);
  if (!available) return null;
  return <aside aria-label="Membership change review" className="mt-3 space-y-1 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-slate-700">
    <Link className="font-medium underline underline-offset-4" to={`/MembershipChange?formId=${encodeURIComponent(formId)}`}>Request a membership change</Link>
    <p className="text-xs">Use the separate administrator review journey. This form and its ordinary submission are unchanged. No payment or membership change runs automatically.</p>
  </aside>;
}
