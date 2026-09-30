import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminFetch } from "@/lib/adminFetch";

const MONTHLY_FREQUENCIES = new Set([
  "monthly",
  "monthly_card",
  "monthly_direct_debit",
  "monthly_instalments",
]);

export function isMonthlyCollectionCommitment(commitment = {}) {
  return MONTHLY_FREQUENCIES.has(String(commitment.paymentFrequency || "").toLowerCase())
    || ["stripe_monthly_card", "card_monthly", "monthly_card", "monthly_direct_debit"]
      .includes(String(commitment.paymentMethod || "").toLowerCase());
}

function formatDate(value) {
  if (!value) return "Not confirmed";
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Not confirmed";
  return parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function makeIdempotencyKey(planId, day) {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `collection-day:${planId}:${day}:${random}`;
}

function responseError(body, fallback) {
  const error = new Error(body?.error || fallback);
  error.code = body?.code;
  return error;
}

export default function MonthlyCollectionSchedule({
  commitment,
  request = adminFetch,
  onChanged,
}) {
  const schedule = commitment?.collectionSchedule || {};
  const monthly = isMonthlyCollectionCommitment(commitment);
  const provider = String(schedule.provider || "").toLowerCase();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDay(schedule.regularDay ? String(schedule.regularDay) : "");
    setPreview(null);
    setError("");
    setUncertain(false);
    setIdempotencyKey(null);
  }, [open, schedule.regularDay]);

  const selectedDay = Number(day);
  const validDay = Number.isInteger(selectedDay) && selectedDay >= 1 && selectedDay <= 28;
  const providerLabel = provider === "stripe"
    ? "Stripe"
    : provider === "gocardless"
      ? "GoCardless"
      : "Payment provider";
  const evidenceLabel = useMemo(() => {
    if (schedule.evidence === "provider") return "Confirmed by the payment provider";
    if (["saved_amendment", "application_schedule"].includes(schedule.evidence)) return "Saved collection schedule";
    if (schedule.evidence === "agreement") return "Agreed collection schedule";
    return "Schedule evidence unavailable";
  }, [schedule.evidence]);

  if (!monthly) return null;

  const submit = async (action, extra = {}) => {
    const response = await request("/api/admin/gocardless-dd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        action,
        planId: schedule.planId,
        collectionDay: selectedDay,
        day: selectedDay,
        version: schedule.version ?? null,
        ...extra,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = responseError(body, "Could not update the monthly collection day");
      error.status = response.status;
      throw error;
    }
    return body;
  };

  const handlePreview = async () => {
    if (!validDay || !schedule.planId) return;
    setBusy(true);
    setError("");
    setUncertain(false);
    try {
      const result = await submit("preview_collection_day");
      setPreview(result.preview || result);
      setIdempotencyKey(makeIdempotencyKey(schedule.planId, selectedDay));
    } catch (previewError) {
      setError(previewError.message);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!preview || !validDay) return;
    const stableKey = idempotencyKey || makeIdempotencyKey(schedule.planId, selectedDay);
    setIdempotencyKey(stableKey);
    setBusy(true);
    setError("");
    setUncertain(false);
    try {
      await submit("change_collection_day", {
        idempotencyKey: stableKey,
        idempotency_key: stableKey,
        preview,
      });
      setOpen(false);
      await onChanged?.();
      toast.success(`Monthly collection day changed to day ${selectedDay}`);
    } catch (saveError) {
      const outcomeUncertain = !saveError.status || saveError.status >= 500
        || ["REQUEST_IN_PROGRESS", "COLLECTION_DAY_CHANGE_IN_PROGRESS", "OUTCOME_UNCERTAIN"]
          .includes(saveError.code);
      setUncertain(outcomeUncertain);
      setError(outcomeUncertain
        ? "The result could not be confirmed. Retry to safely check the same request; do not submit a different day."
        : saveError.message);
    } finally {
      setBusy(false);
    }
  };

  const previewEffectiveDate = preview?.effectiveDate || preview?.effective_date
    || preview?.nextCollectionDate || preview?.next_collection_date;
  const pendingDate = preview?.unchangedPendingDate || preview?.unchanged_pending_date
    || preview?.pendingCollectionDate || preview?.pending_collection_date
    || schedule.nextConfirmedDate;

  return (
    <section className="mt-4 space-y-3 border-t pt-4" data-testid={`monthly-collection-schedule-${commitment.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Monthly collection schedule</p>
            <p className="text-xs text-muted-foreground">{providerLabel} · {evidenceLabel}</p>
          </div>
        </div>
        {schedule.canEdit === true && provider === "gocardless" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
            data-testid={`button-edit-collection-day-${commitment.id}`}
          >
            <Pencil className="mr-1 h-3.5 w-3.5" />
            Change day
          </Button>
        )}
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Regular collection day</dt>
          <dd className="font-medium" data-testid={`text-collection-day-${commitment.id}`}>
            {schedule.regularDay ? `Day ${schedule.regularDay} of each month` : "Not confirmed"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Next confirmed collection</dt>
          <dd className="font-medium">{formatDate(schedule.nextConfirmedDate)}</dd>
        </div>
      </dl>
      {schedule.reason && (
        <p className="text-xs text-muted-foreground" data-testid={`text-collection-day-reason-${commitment.id}`}>
          {schedule.reason}
        </p>
      )}

      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change monthly collection day</DialogTitle>
            <DialogDescription>
              Choose a regular day from 1 to 28. Preview the effective date before saving.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`collection-day-${commitment.id}`}>Day of month</Label>
              <Input
                id={`collection-day-${commitment.id}`}
                type="number"
                min="1"
                max="28"
                step="1"
                value={day}
                disabled={busy}
                onChange={(event) => {
                  setDay(event.target.value);
                  setPreview(null);
                  setError("");
                  setUncertain(false);
                  setIdempotencyKey(null);
                }}
                data-testid={`input-collection-day-${commitment.id}`}
              />
              {!validDay && day && <p className="text-xs text-destructive">Enter a whole number from 1 to 28.</p>}
            </div>
            {preview && (
              <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-2" data-testid="collection-day-preview">
                <p><span className="text-muted-foreground">New regular day:</span> Day {selectedDay}</p>
                <p><span className="text-muted-foreground">Effective from:</span> {formatDate(previewEffectiveDate)}</p>
                {pendingDate && (
                  <p className="text-muted-foreground">
                    The already pending collection on {formatDate(pendingDate)} will not change. The new day applies after it.
                  </p>
                )}
                {preview.message && <p className="text-muted-foreground">{preview.message}</p>}
              </div>
            )}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
            {!preview ? (
              <Button type="button" disabled={!validDay || busy || !schedule.planId} onClick={handlePreview}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Preview change
              </Button>
            ) : (
              <Button type="button" disabled={busy} onClick={handleConfirm}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {uncertain ? "Retry same change" : "Confirm change"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}