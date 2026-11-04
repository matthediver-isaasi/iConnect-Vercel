import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { eventInvoiceId } from "../../../shared/eventInvoiceRecoveryPresentation.mjs";

export default function ActivityInvoiceActions({ booking, compact = false }) {
  const [busy, setBusy] = useState(false);
  if (!eventInvoiceId(booking) || !booking.booking_group_reference) return null;
  const url = `/api/booking-invoice/${encodeURIComponent(booking.booking_group_reference)}`;
  const download = async () => {
    setBusy(true);
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Unable to download this invoice.");
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = "invoice.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch {
      toast.error("Unable to download this invoice. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={compact ? "inline-flex items-center gap-1" : "flex flex-wrap gap-2 pt-2"}>
      <Button variant={compact ? "ghost" : "outline"} size={compact ? "icon" : "sm"} className={compact ? "h-7 w-7" : undefined} asChild>
        <a href={`${url}?inline=true`} target="_blank" rel="noopener noreferrer" aria-label="View invoice" title="View invoice">
          <Eye className={compact ? "w-4 h-4" : "w-4 h-4 mr-2"} />{!compact && "View invoice"}
        </a>
      </Button>
      <Button type="button" variant={compact ? "ghost" : "outline"} size={compact ? "icon" : "sm"} className={compact ? "h-7 w-7" : undefined} disabled={busy} onClick={download} aria-label="Download invoice" title="Download invoice">
        {busy ? <Loader2 className={`${compact ? "w-4 h-4" : "w-4 h-4 mr-2"} animate-spin`} /> : <Download className={compact ? "w-4 h-4" : "w-4 h-4 mr-2"} />}
        {!compact && "Download invoice"}
      </Button>
    </div>
  );
}
