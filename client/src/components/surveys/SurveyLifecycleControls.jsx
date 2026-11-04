import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSurveyLifecycle } from "@/hooks/useSurveyLifecycle";
import { surveyActionLabels, surveyLifecycleState } from "@/lib/surveyLifecycle";
import SurveyLifecycleDialog from "./SurveyLifecycleDialog";

export default function SurveyLifecycleControls({ form, onComplete }) {
  const [request, setRequest] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const lifecycle = useSurveyLifecycle(form?.id);
  const state = lifecycle.data?.state || surveyLifecycleState(form);
  const currentVersion = Number(form?.survey_settings?.current_version) || 0;
  const actions = state === "archived" ? ["restore", "delete"] : [
    ...(state === "active" ? ["pause", "close"] : ["paused", "closed"].includes(state) && currentVersion > 0 ? ["activate"] : []),
    ...(state !== "closed" && state !== "draft" && state !== "active" ? ["close"] : []),
    "archive",
    "delete",
  ];
  const history = Array.isArray(lifecycle.data?.history) ? lifecycle.data.history : [];
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4" data-testid="survey-lifecycle-controls">
      <div className="flex items-center justify-between gap-3"><h3 className="font-medium text-slate-900">Survey lifecycle</h3><Badge variant={state === "active" ? "default" : "secondary"} className="capitalize">{state}</Badge></div>
      <p className="text-sm text-slate-600">{currentVersion > 0 ? `Published Version ${currentVersion} is retained. ${state === "active" ? "Valid links serve this published snapshot." : "This survey is not accepting responses."}` : "No published snapshot. Publish the draft before activating this survey."}</p>
      <p className="text-xs text-slate-500">{form?.survey_settings?.has_unpublished_changes ? "Unpublished draft changes are not live. " : ""}Saving draft edits does not take the published survey offline. Only explicit publishing replaces the snapshot served by live links.</p>
      {!form?.id ? <p className="text-sm text-slate-500">Save this survey to manage its lifecycle.</p> : <div className="flex flex-wrap gap-2">{actions.map(action => <Button type="button" key={action} variant="outline" size="sm" onClick={() => setRequest({ form_id: form.id, action })}>{surveyActionLabels[action]}</Button>)}<Button type="button" variant="ghost" size="sm" onClick={() => setShowHistory(value => !value)}>{showHistory ? "Hide history" : "View lifecycle history"}</Button></div>}
      {showHistory && <div className="border-t border-slate-200 pt-3 text-sm">
        <h4 className="mb-2 font-medium">Lifecycle history</h4>
        {lifecycle.isLoading ? <div role="status" className="h-14 animate-pulse rounded bg-slate-200" /> : lifecycle.isError ? <div role="alert">History could not be loaded. <button className="text-blue-600 underline" onClick={() => lifecycle.refetch()}>Retry</button></div> : history.length ? <ol className="max-h-64 space-y-3 overflow-y-auto">{history.map((entry, index) => <li key={entry.id || index} className="border-l-2 border-slate-200 pl-3"><p className="font-medium">{surveyActionLabels[entry.action] || entry.action || "Survey updated"}</p><p className="text-xs text-slate-500">{entry.previous_status || entry.previous_state || "—"} → {entry.new_status || entry.new_state || "—"} · {entry.created_at ? new Date(entry.created_at).toLocaleString() : "Date not recorded"}</p>{entry.actor && <p className="text-xs text-slate-500">{typeof entry.actor === "string" ? entry.actor : "Administrator"}</p>}</li>)}</ol> : <p className="text-slate-500">No lifecycle history is available yet. Historical responses and event associations remain accessible through reports and the Events tab.</p>}
      </div>}
      <SurveyLifecycleDialog request={request} onClose={() => setRequest(null)} onComplete={onComplete} />
    </div>
  );
}
