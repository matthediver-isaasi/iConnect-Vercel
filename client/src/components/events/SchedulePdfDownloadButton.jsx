import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTenantBranding } from "@/contexts/TenantBrandingContext";
import { publicClient } from "@/api/publicClient";

export default function SchedulePdfDownloadButton({ event, sessions, timezone, eventTracks, trackColorMap, speakerMap }) {
  const tenant = useTenantBranding();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const download = async () => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      // No new data retrieval or PDF dependency loading until requested.
      // The public client resolves the current host's tenant, never an event's
      // arbitrary tenant id. Use its canonical logo, not session/event artwork.
      const branding = tenant?.branding || (await publicClient.getTenantBranding())?.branding;
      if (!branding) throw new Error("Tenant branding could not be loaded. Please retry.");
      const { downloadSchedulePdf } = await import("./schedulePdf.mjs");
      await downloadSchedulePdf({ event, sessions, timezone, eventTracks, trackColorMap, speakerMap }, branding.logoUrl || branding.headerLogoUrl);
    } catch (cause) {
      setError(cause?.message || "The PDF could not be downloaded. Please retry.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mb-4 flex flex-col items-end gap-2">
      <Button type="button" variant="outline" size="sm" onClick={download} disabled={busy || !sessions?.length} aria-busy={busy} data-testid="button-download-schedule-pdf">
        <Download className="w-4 h-4 mr-1.5" aria-hidden="true" />
        {busy ? "Preparing PDF…" : error ? "Retry PDF download" : "Download PDF"}
      </Button>
      {busy && <span role="status" className="text-xs text-slate-500">Preparing your printable programme…</span>}
      {error && <p role="alert" className="text-sm text-red-700 max-w-md text-right">{error}</p>}
    </div>
  );
}
