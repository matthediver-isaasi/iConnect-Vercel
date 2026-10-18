import { useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AmendQuoteButton({ pending, onAmend }) {
  const lock = useRef(false);
  const [working, setWorking] = useState(false);
  const busy = pending || working;
  return <Button disabled={busy} aria-busy={busy} onClick={async () => {
    if (busy || lock.current) return;
    lock.current = true;
    setWorking(true);
    try {
      await onAmend();
    } catch {
      // The parent mutation presents the actionable error toast.
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }}>
    {working ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />}
    <span role="status" aria-live="polite">{working ? "Preparing amendment…" : "Amend"}</span>
  </Button>;
}
