import { useId } from "react";
import { Link2Off } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revokeLinkAvailability } from "./proposalLifecycle";

export default function RevokeQuoteLink({ onRevoke, ...state }) {
  const descriptionId = useId();
  const availability = revokeLinkAvailability(state);
  return <div className="flex max-w-xs flex-col gap-1.5">
    <Button variant="outline" disabled={!availability.enabled} aria-describedby={descriptionId}
      onClick={() => { if (availability.enabled) onRevoke(); }}>
      <Link2Off aria-hidden="true" className="mr-2 h-4 w-4" />Revoke link
    </Button>
    <p id={descriptionId} className="text-xs text-slate-500">{availability.reason}</p>
  </div>;
}
