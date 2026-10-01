import React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import {
  eventInvoiceAwaited,
  eventInvoiceId,
  eventInvoiceNeedsAttention,
  eventInvoiceNumber,
  eventInvoiceRecoveryStatus,
  eventInvoiceRetryAt,
} from "../../../../shared/eventInvoiceRecoveryPresentation.mjs";

const CUSTOMER_MESSAGE = "Your invoice is being prepared and will appear here when ready. No action is needed from you.";

export default function EventInvoiceStatus({ record, admin = false, showInvoice = false, testId }) {
  const hasInvoice = !!eventInvoiceId(record);
  const attention = admin && eventInvoiceNeedsAttention(record);
  const awaited = eventInvoiceAwaited(record);
  const retryAt = admin && !attention && ['pending', 'processing', 'retry'].includes(eventInvoiceRecoveryStatus(record))
    ? eventInvoiceRetryAt(record) : null;
  if (!attention && !awaited && !(showInvoice && (hasInvoice || eventInvoiceNumber(record)))) return null;

  const message = attention
    ? "Automatic invoice recovery needs an administrator's attention. Check the recovery operation before taking further action."
    : CUSTOMER_MESSAGE;
  return (
    <span className="inline-flex flex-col items-start gap-1" data-testid={testId}>
      {showInvoice && (hasInvoice || eventInvoiceNumber(record)) && (
        <span className="text-xs font-mono">{eventInvoiceNumber(record) || "Invoice available"}</span>
      )}
      {(attention || awaited) && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium cursor-help ${attention ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 bg-slate-50 text-slate-600"}`}
                aria-label={`${attention ? "Needs attention" : "Invoice awaited"}. ${message}`}
              >
                {attention ? "Needs attention" : "Invoice awaited"}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{message}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {retryAt && (
        <span className="text-xs text-muted-foreground">
          Next retry: <time dateTime={retryAt.toISOString()}>{retryAt.toLocaleString("en-GB")}</time>
        </span>
      )}
    </span>
  );
}