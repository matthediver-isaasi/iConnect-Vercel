import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

const formatStart = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * Reusable change-zoom dialog used by both single events and complex-event
 * sessions. The server contract is identical for both targets — the caller
 * supplies the endpoint base (e.g. `/api/events/123` or
 * `/api/complex-event-sessions/abc`) and the dialog hits `${base}/change-zoom`
 * for the impact preview (GET) and the action (POST).
 *
 * mode controls which controls + actions are visible:
 *   - 'attach': no Zoom currently linked. Hide cancel-old + convert-in-person +
 *     Clear button. Primary action = "Attach Zoom".
 *   - 'change': existing Zoom linked. Show everything. Primary = "Update Zoom
 *     Link", secondary = "Clear Zoom Link".
 *   - 'detach': existing Zoom linked, admin wants to remove. Hide target +
 *     register/resend. Primary = "Clear Zoom Link".
 */
export default function ChangeZoomDialog({
  open,
  onOpenChange,
  endpointBase,
  mode = "change",
  targetLabel = "event",
  initialType = "webinar",
  onSuccess,
}) {
  const [type, setType] = useState(initialType);
  const [targetId, setTargetId] = useState("");
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [impactCount, setImpactCount] = useState(null);
  const [cancelOld, setCancelOld] = useState(true);
  const [registerNew, setRegisterNew] = useState(true);
  const [resendEmails, setResendEmails] = useState(true);
  const [convertInPerson, setConvertInPerson] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isAttach = mode === "attach";
  const isDetach = mode === "detach";

  useEffect(() => {
    if (!open) return;
    setType(initialType);
    setTargetId("");
    setShowPast(false);
    setSearch("");
    setDateFrom("");
    setDateTo("");
    setCancelOld(!isAttach);
    setRegisterNew(!isDetach);
    setResendEmails(!isDetach);
    setConvertInPerson(false);
    setImpactCount(null);

    if (!isAttach) {
      fetch(`${endpointBase}/change-zoom`, { credentials: "include" })
        .then(r => (r.ok ? r.json() : null))
        .then(d => setImpactCount(d?.confirmedBookings ?? null))
        .catch(() => setImpactCount(null));
    }

    if (!isDetach) {
      loadItems(initialType, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadItems = (t, includePast) => {
    setLoadingItems(true);
    const qs = includePast ? "" : "?upcoming=true";
    fetch(`/api/zoom/${t === "meeting" ? "meetings" : "webinars"}${qs}`, { credentials: "include" })
      .then(r => r.json())
      .then(d => setItems(Array.isArray(d) ? d : (d?.data || [])))
      .catch(() => setItems([]))
      .finally(() => setLoadingItems(false));
  };

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toTs = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : null;
    return items.filter((it) => {
      const title = String(it.topic || it.title || it.id || "").toLowerCase();
      if (q && !title.includes(q)) return false;
      if (fromTs !== null || toTs !== null) {
        const start = it.start_time ? new Date(it.start_time).getTime() : NaN;
        if (isNaN(start)) return false;
        if (fromTs !== null && start < fromTs) return false;
        if (toTs !== null && start > toTs) return false;
      }
      return true;
    });
  }, [items, search, dateFrom, dateTo]);

  const handleAttachOrChange = async () => {
    if (!targetId) {
      toast.error(`Please select a ${type}`);
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        zoom_webinar_id: type === "webinar" ? targetId : null,
        zoom_meeting_id: type === "meeting" ? targetId : null,
        cancelOld,
        registerNew,
        resendConfirmations: resendEmails,
      };
      const resp = await fetch(`${endpointBase}/change-zoom`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Change Zoom failed");
      }
      const result = await resp.json();
      const verb = isAttach ? "attached" : "updated";
      toast.success(`Zoom ${verb}. Cancelled ${result.cancelled || 0}, registered ${result.registered || 0}, emailed ${result.emailed || 0}.`);
      if (result.errors?.length) console.warn("[change-zoom] errors:", result.errors);
      onOpenChange(false);
      if (onSuccess) onSuccess(result);
    } catch (err) {
      toast.error(`Failed to ${isAttach ? "attach" : "change"} Zoom: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async () => {
    const msg = convertInPerson
      ? `Clear the Zoom link AND convert this ${targetLabel} to in-person? Existing registrants can be cancelled.`
      : `Clear the Zoom link from this ${targetLabel}? It will remain Online with no join link until you set one. Existing registrants can be cancelled.`;
    if (!confirm(msg)) return;
    setSubmitting(true);
    try {
      const body = {
        zoom_webinar_id: null,
        zoom_meeting_id: null,
        cancelOld,
        registerNew: false,
        resendConfirmations: false,
        convert_to_in_person: convertInPerson,
      };
      const resp = await fetch(`${endpointBase}/change-zoom`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Clear Zoom failed");
      }
      const result = await resp.json();
      toast.success(`Zoom cleared. Cancelled ${result.cancelled || 0} registrant(s).`);
      onOpenChange(false);
      if (onSuccess) onSuccess(result);
    } catch (err) {
      toast.error(`Failed to clear Zoom: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const titleByMode = {
    attach: "Attach Zoom Link",
    change: "Change Zoom Link",
    detach: "Detach Zoom Link",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid={`dialog-change-zoom-${targetLabel}`}>
        <DialogHeader>
          <DialogTitle>{titleByMode[mode]}</DialogTitle>
          <DialogDescription>
            {isAttach
              ? `Attach a Zoom ${type} to this ${targetLabel}. Confirmed attendees will be registered with Zoom and (optionally) emailed the new join link.`
              : isDetach
                ? `Remove the Zoom link from this ${targetLabel}. Existing confirmed attendees can be cancelled from the previous Zoom.`
                : `Switch this ${targetLabel} to a different Zoom ${type}. Existing confirmed attendees can be cancelled from the previous Zoom and re-registered against the new one.`}
            {impactCount !== null && !isAttach && (
              <span className="block mt-2 font-medium text-foreground" data-testid="text-change-zoom-impact">
                Impact: {impactCount} confirmed booking{impactCount === 1 ? "" : "s"} would be affected.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!isDetach && (
            <>
              <div>
                <Label className="mb-2 block">Type</Label>
                <RadioGroup
                  value={type}
                  onValueChange={(v) => {
                    setType(v);
                    setTargetId("");
                    setSearch("");
                    loadItems(v, showPast);
                  }}
                  className="grid grid-cols-2 gap-2"
                >
                  <div className="flex items-center space-x-2 p-2 rounded-md border">
                    <RadioGroupItem value="webinar" id={`cz-${targetLabel}-webinar`} data-testid="radio-change-zoom-webinar" />
                    <Label htmlFor={`cz-${targetLabel}-webinar`} className="cursor-pointer">Webinar</Label>
                  </div>
                  <div className="flex items-center space-x-2 p-2 rounded-md border">
                    <RadioGroupItem value="meeting" id={`cz-${targetLabel}-meeting`} data-testid="radio-change-zoom-meeting" />
                    <Label htmlFor={`cz-${targetLabel}-meeting`} className="cursor-pointer">Meeting</Label>
                  </div>
                </RadioGroup>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                  <Label>Target {type}</Label>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`cz-${targetLabel}-show-past`} className="text-sm text-muted-foreground cursor-pointer">
                      Show past
                    </Label>
                    <Switch
                      id={`cz-${targetLabel}-show-past`}
                      checked={showPast}
                      onCheckedChange={(v) => {
                        setShowPast(!!v);
                        setTargetId("");
                        loadItems(type, !!v);
                      }}
                      data-testid="switch-change-zoom-show-past"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor={`cz-${targetLabel}-date-from`} className="text-sm text-muted-foreground">From</Label>
                    <Input
                      id={`cz-${targetLabel}-date-from`}
                      type="date"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      className="w-auto"
                      data-testid="input-change-zoom-date-from"
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor={`cz-${targetLabel}-date-to`} className="text-sm text-muted-foreground">To</Label>
                    <Input
                      id={`cz-${targetLabel}-date-to`}
                      type="date"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      className="w-auto"
                      data-testid="input-change-zoom-date-to"
                    />
                  </div>
                  {(dateFrom || dateTo) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => { setDateFrom(""); setDateTo(""); }}
                      data-testid="button-change-zoom-clear-dates"
                    >
                      Clear dates
                    </Button>
                  )}
                </div>
                <Command shouldFilter={false} className="rounded-md border">
                  <CommandInput
                    placeholder={`Search ${type}s by title…`}
                    value={search}
                    onValueChange={setSearch}
                    data-testid="input-change-zoom-search"
                  />
                  <CommandList className="max-h-56">
                    {loadingItems ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading…
                      </div>
                    ) : filteredItems.length === 0 ? (
                      <CommandEmpty data-testid="text-change-zoom-empty">
                        {showPast ? `No ${type}s found` : `No upcoming ${type}s found`}
                      </CommandEmpty>
                    ) : (
                      filteredItems.map((it) => (
                        <CommandItem
                          key={it.id}
                          value={String(it.id)}
                          onSelect={() => setTargetId(targetId === it.id ? "" : it.id)}
                          className="flex items-start justify-between gap-2"
                          data-testid={`option-zoom-${it.id}`}
                        >
                          <span className="break-words whitespace-normal min-w-0 flex-1">{it.topic || it.title || it.id}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{formatStart(it.start_time)}</span>
                          <Check className={`h-4 w-4 shrink-0 ${targetId === it.id ? "opacity-100" : "opacity-0"}`} />
                        </CommandItem>
                      ))
                    )}
                  </CommandList>
                </Command>
              </div>
            </>
          )}

          <div className="space-y-2 pt-2 border-t">
            {!isAttach && (
              <div className="flex items-center space-x-2">
                <Checkbox
                  id={`cz-${targetLabel}-cancel-old`}
                  checked={cancelOld}
                  onCheckedChange={(v) => setCancelOld(!!v)}
                  data-testid="checkbox-change-zoom-cancel-old"
                />
                <Label htmlFor={`cz-${targetLabel}-cancel-old`} className="cursor-pointer text-sm">
                  Cancel previous Zoom registrants
                </Label>
              </div>
            )}
            {!isDetach && (
              <>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`cz-${targetLabel}-register-new`}
                    checked={registerNew}
                    onCheckedChange={(v) => setRegisterNew(!!v)}
                    data-testid="checkbox-change-zoom-register-new"
                  />
                  <Label htmlFor={`cz-${targetLabel}-register-new`} className="cursor-pointer text-sm">
                    Register confirmed attendees with new Zoom
                  </Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`cz-${targetLabel}-resend`}
                    checked={resendEmails}
                    onCheckedChange={(v) => setResendEmails(!!v)}
                    data-testid="checkbox-change-zoom-resend"
                  />
                  <Label htmlFor={`cz-${targetLabel}-resend`} className="cursor-pointer text-sm">
                    Resend confirmation emails with new join link
                  </Label>
                </div>
              </>
            )}
            {!isAttach && (
              <div className="flex items-center space-x-2 pt-2 border-t">
                <Checkbox
                  id={`cz-${targetLabel}-convert-in-person`}
                  checked={convertInPerson}
                  onCheckedChange={(v) => setConvertInPerson(!!v)}
                  data-testid="checkbox-change-zoom-convert-in-person"
                />
                <Label htmlFor={`cz-${targetLabel}-convert-in-person`} className="cursor-pointer text-sm">
                  When clearing Zoom: also convert this {targetLabel} to in-person
                </Label>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="button-change-zoom-cancel"
          >
            Cancel
          </Button>
          {mode === "change" && (
            <Button
              type="button"
              variant="ghost"
              onClick={handleClear}
              disabled={submitting}
              data-testid="button-change-zoom-clear"
            >
              Clear Zoom Link
            </Button>
          )}
          {isDetach ? (
            <Button
              type="button"
              onClick={handleClear}
              disabled={submitting}
              data-testid="button-change-zoom-confirm"
            >
              {submitting ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />Clearing…</>) : "Clear Zoom Link"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={handleAttachOrChange}
              disabled={submitting || !targetId}
              data-testid="button-change-zoom-confirm"
            >
              {submitting
                ? (<><Loader2 className="h-4 w-4 mr-2 animate-spin" />{isAttach ? "Attaching…" : "Updating…"}</>)
                : (isAttach ? "Attach Zoom Link" : "Update Zoom Link")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
