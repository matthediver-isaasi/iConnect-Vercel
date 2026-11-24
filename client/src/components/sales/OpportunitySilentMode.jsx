import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { SALES_AUTOMATIC_COMMUNICATIONS } from "@shared/salesCommunicationPolicy.js";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const draftFrom = (opportunity) => ({
  enabled: opportunity.silent_mode === true,
  communications: Array.isArray(opportunity.automatic_communications) ? [...opportunity.automatic_communications] : [],
  version: opportunity.version,
});

export default function OpportunitySilentMode({ opportunity, canEdit = false, request, onChanged, onReload }) {
  const helpId = useId();
  const [draft, setDraft] = useState(() => draftFrom(opportunity));
  const [feedback, setFeedback] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    // Background detail refreshes must not overwrite an unsaved or failed draft.
    if (!dirty.current) setDraft(draftFrom(opportunity));
  }, [opportunity]);
  const change = (patch) => {
    dirty.current = true;
    setDraft(current => ({ ...current, ...patch }));
    setFeedback(null);
  };
  const reload = async () => {
    setReloading(true);
    try {
      const latest = await onReload();
      if (!latest) throw new Error("The latest opportunity could not be loaded.");
      dirty.current = false;
      setDraft(draftFrom(latest));
      setConflict(false);
      setFeedback({ error: true, message: "Opportunity changed elsewhere. The latest settings have been loaded; review them before saving again." });
    } catch (error) {
      setFeedback({ error: true, message: `Could not reload opportunity: ${error.message}` });
    } finally {
      setReloading(false);
    }
  };
  const save = useMutation({
    mutationFn: () => request(`/api/opportunities/${opportunity.id || opportunity._id}`, {
      method: "PATCH",
      body: JSON.stringify({
        action: "silent-mode",
        expectedVersion: draft.version,
        silentMode: draft.enabled,
        automaticCommunications: draft.communications,
      }),
    }),
    onSuccess: (result) => {
      const updated = result?.opportunity || result?.data?.opportunity || result?.data || result;
      dirty.current = false;
      setDraft(draftFrom(updated));
      setFeedback({ error: false, message: "Silent mode settings saved. No communications were sent." });
      onChanged();
    },
    onError: async (error) => {
      if (error.status === 409 || error.status === 412) {
        setConflict(true);
        await reload();
      } else {
        setFeedback({ error: true, message: `Could not save silent mode: ${error.message}. Your selections have been kept. Please try again.` });
      }
    },
  });
  const disabled = !canEdit || save.isPending || reloading || conflict;
  return <Card>
    <CardHeader><CardTitle>Silent mode</CardTitle></CardHeader>
    <CardContent className="space-y-4" aria-busy={save.isPending || reloading}>
      <label className="flex items-center gap-3 text-sm font-medium text-slate-900">
        <input type="checkbox" className="h-4 w-4 rounded border-slate-300 accent-blue-600" checked={draft.enabled} disabled={disabled} aria-describedby={helpId} onChange={event => change({ enabled: event.target.checked })} />
        Enable silent mode
      </label>
      <div id={helpId} className="space-y-1 text-sm text-slate-500">
        <p>When enabled, automatic communications are blocked unless selected below. With silent mode off, normal automatic communication behaviour is preserved. Turning it off retains your selections.</p>
        <p>Checked communications are permitted only at their normal trigger; saving never sends immediately. Suppressed communications are not replayed. Manual sends and required signing verification are unchanged.</p>
      </div>
      {draft.enabled && <fieldset className="space-y-3 rounded-lg border bg-slate-50 p-4" disabled={disabled}>
        <legend className="px-1 text-sm font-medium text-slate-900">Allowed automatic communications</legend>
        <p className="text-sm text-slate-500">Leave all unchecked to block every optional automatic communication.</p>
        {SALES_AUTOMATIC_COMMUNICATIONS.map(({ id, label, description }) => <label key={id} className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 accent-blue-600" checked={draft.communications.includes(id)} onChange={event => change({ communications: event.target.checked ? [...draft.communications, id] : draft.communications.filter(value => value !== id) })} />
          <span><span className="block font-medium text-slate-900">{label}</span><span className="block text-slate-500">{description}</span></span>
        </label>)}
      </fieldset>}
      {!canEdit && <p className="text-sm text-slate-500">You have read-only access to these settings.</p>}
      {feedback && <p role={feedback.error ? "alert" : "status"} className={`text-sm ${feedback.error ? "text-rose-700" : "text-slate-700"}`}>{feedback.message}</p>}
      {conflict && !reloading && <Button variant="outline" onClick={reload}>Reload latest settings</Button>}
      {canEdit && <div className="flex justify-end"><Button disabled={disabled || !dirty.current} onClick={() => { if (!disabled) save.mutate(); }}>{save.isPending ? "Saving…" : reloading ? "Reloading…" : "Save silent mode"}</Button></div>}
    </CardContent>
  </Card>;
}
