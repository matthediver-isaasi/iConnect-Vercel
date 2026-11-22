import { useState } from "react";
import { Eye, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EvidenceValue, Notice, Panel, RecordTable } from "./LifecycleUI";

export default function ImpactPreview({ config, preview, pending, dirty, onPreview, onApprove, onPause, onSelect }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const canConfigure = config.permissions.configure === true;
  const complete = preview?.complete === true && !preview.nextCursor;
  const current = preview?.revision === config.revision;
  const ready = config.executionReady === true && complete && current && !dirty && !!preview?.previewId;
  return <Panel step="02 / Preview & approve" title="Automation controls" description="Only a complete preview of the saved policy can be approved. Previewing does not change members.">
    <div className="ml-panel-body space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm font-semibold">{config.enabled ? "Automation enabled" : "Automation paused"}</p>
          <p className="ml-muted mt-1 text-xs">Saved policy revision {config.revision}</p></div>
        {canConfigure && config.enabled && <Button variant="outline" onClick={onPause} disabled={!!pending || !config.executionReady}><Pause className="h-4 w-4" aria-hidden="true" />{pending === "pause" ? "Pausing…" : "Pause automation"}</Button>}
      </div>
      {!config.executionReady && <Notice tone="warning" title="Execution is not ready">Approval is blocked even if the preview completes. Resolve the readiness issues shown above before enabling rules.</Notice>}
      {config.revision === 0 && <Notice title="Save the initial draft first">A saved policy revision is required for a versioned preview.</Notice>}
      {dirty && <Notice tone="warning">Save or discard unsaved configuration before generating or approving a preview.</Notice>}
      {canConfigure && <Button variant="outline" onClick={() => { setAcknowledged(false); onPreview(); }} disabled={!!pending || dirty || config.revision === 0}><Eye className="h-4 w-4" aria-hidden="true" />{pending === "preview" ? "Generating preview…" : preview ? "Generate fresh impact preview" : "Generate impact preview"}</Button>}
      {!preview && <div className="ml-empty rounded-lg"><h3 className="text-sm font-semibold">No approved impact assumed</h3><p className="ml-muted mt-2 text-sm">Generate a versioned preview to inspect retained, eligible and uncertain records. Unavailable evidence never means inactivity.</p></div>}
      {preview && <>
        <div className="rounded-lg border p-4">
          <p className="text-sm font-semibold">Preview revision {preview.revision} · {complete ? "All pages loaded" : "Incomplete — approval blocked"}</p>
          <p className="ml-code ml-muted mt-1">Preview ID: {preview.previewId}</p>
          <div className="mt-3"><EvidenceValue value={preview.counts} /></div>
          <p className="ml-muted mt-3 text-xs">{preview.items.length} proposal rows loaded. Counts are reported by the server; no eligibility is calculated in the browser.</p>
        </div>
        {!current && <Notice tone="error">This preview belongs to a different policy revision. Generate a fresh preview.</Notice>}
        {preview.items.length > 0
          ? <RecordTable items={preview.items} preview roles={config.roles} onSelect={onSelect} disabled={!!pending || (!config.executionReady && !config.reviewReady)} />
          : <Notice title="No proposal rows on the loaded pages">This does not establish that evaluation is complete. Check preview completion and counts before approval.</Notice>}
        {preview.nextCursor && <Button variant="outline" disabled={!!pending || dirty || !current} onClick={() => onPreview(preview)}>{pending === "preview_more" ? "Loading next preview page…" : "Load next preview page"}</Button>}
        {!complete && !preview.nextCursor && <Notice tone="warning">The server reports an incomplete preview without a continuation cursor. Generate a fresh preview or ask an administrator to investigate. Approval stays blocked.</Notice>}
        {canConfigure && <div className="space-y-3 border-t pt-4">
          <label className="ml-check"><input key={preview.previewId} type="checkbox" checked={acknowledged} disabled={!ready || !!pending} onChange={event => setAcknowledged(event.target.checked)} />
            <span>I have reviewed this revision’s complete impact preview and authorise the server to enable these rules. This does not authorise minimisation or deletion.</span></label>
          <Button disabled={!ready || !acknowledged || !!pending || config.enabled} onClick={() => { setAcknowledged(false); onApprove(); }}>
            {pending === "approve" ? "Requesting approval…" : config.enabled ? "Rules already enabled" : "Approve preview & enable rules"}
          </Button>
        </div>}
      </>}
    </div>
  </Panel>;
}
