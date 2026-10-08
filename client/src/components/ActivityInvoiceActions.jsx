import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { eventInvoiceId } from "../../../shared/eventInvoiceRecoveryPresentation.mjs";

export default function ActivityInvoiceActions({ booking }) {
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
    <div className="flex flex-wrap gap-2 pt-2">
      <Button variant="outline" size="sm" asChild>
        <a href={`${url}?inline=true`} target="_blank" rel="noopener noreferrer">
          <Eye className="w-4 h-4 mr-2" />View invoice
        </a>
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={download}>
        {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Download className="w-4 h-4 mr-2" />}
        Download invoice
      </Button>
    </div>
  );
}
