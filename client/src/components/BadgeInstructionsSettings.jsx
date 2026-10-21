import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useBadgeTenant, useBadgeInstructions, useSaveBadgeInstructions, readBadgePdf, previewBadgePdf, badgeDocumentUrl } from "@/hooks/useBadgeInstructions";
import { useLayoutContext } from "@/contexts/LayoutContext";

export default function BadgeInstructionsSettings() {
  const { memberInfo, sessionValidated } = useLayoutContext();
  const tenantId = useBadgeTenant(sessionValidated ? memberInfo?.tenant_id : null);
  return (
    <Card className="mb-6" data-testid="badge-instructions-settings">
      <CardHeader>
        <CardTitle className="text-lg">Badge sharing instructions</CardTitle>
        <CardDescription>Choose the help members see when sharing their membership badges.</CardDescription>
      </CardHeader>
      <CardContent>
        {tenantId ? <TenantBadgeInstructions key={tenantId} tenantId={tenantId} /> :
          <p role="status" className="text-sm text-slate-600">Select an active tenant to manage badge instructions.</p>}
      </CardContent>
    </Card>
  );
}

export function TenantBadgeInstructions({ tenantId }) {
  const query = useBadgeInstructions(tenantId);
  const mutation = useSaveBadgeInstructions(tenantId);
  const [selection, setSelection] = useState(null);
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [cleanupWarning, setCleanupWarning] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const config = query.data;
  const busy = reading || mutation.isPending;
  const mode = selection ?? config?.mode ?? "standard";

  async function run(method, body, message, cleanupRetry = false) {
    setError(""); setSuccess("");
    try {
      const saved = await mutation.mutateAsync({ method, body });
      if (method !== "POST") setSelection(saved.mode);
      setCleanupWarning(saved.warning || "");
      setSuccess(saved.warning && method === "DELETE"
        ? "PDF removed from use. Standard help restored; permanent storage cleanup is still pending."
        : saved.warning && cleanupRetry ? "Settings saved. Storage cleanup is still pending." : message);
      return true;
    } catch (err) {
      setError(err.message);
      if (err.warning) setCleanupWarning(err.warning);
      return false;
    }
  }

  async function upload() {
    setError(""); setSuccess(""); setReading(true);
    try {
      const contentBase64 = await readBadgePdf(file);
      if (await run("POST", {
        action: "upload", revision: config.revision, filename: file.name,
        mimeType: "application/pdf", contentBase64,
      }, "PDF uploaded. Choose a mode and save to update the help link.")) setFile(null);
    } catch (err) { setError(err.message); }
    finally { setReading(false); }
  }

  if (query.isLoading) return <div aria-label="Loading badge instructions" role="status" className="space-y-3 animate-pulse"><div className="h-5 w-48 rounded bg-slate-100" /><div className="h-16 rounded bg-slate-100" /></div>;
  if (!config) return <div role="alert" className="space-y-3"><p>{query.error?.message || "Could not load badge instructions."}</p><Button type="button" variant="outline" onClick={() => query.refetch()} disabled={query.isFetching}>Retry loading instructions</Button></div>;
  if (!config.canManage) return <p className="text-sm text-slate-600">You do not have permission to manage badge instructions.</p>;

  return (
    <div className="space-y-4" aria-busy={busy}>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="text-sm font-medium mb-2">Instructions source</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`badge-mode-${tenantId}`} value="standard" checked={mode === "standard"} onChange={() => { setSelection("standard"); setSuccess(""); }} />Standard help page (default)</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={`badge-mode-${tenantId}`} value="pdf" checked={mode === "pdf"} onChange={() => { setSelection("pdf"); setSuccess(""); }} />Tenant PDF</label>
      </fieldset>

      <div className="rounded-lg border border-slate-200 p-4 space-y-3">
        {config.document ? (
          <div className="space-y-2">
            <a href={badgeDocumentUrl(tenantId)} target="_blank" rel="noopener noreferrer"
              onClick={(event) => previewBadgePdf(event, tenantId, setError)}
              className="text-sm text-blue-700 underline break-all">{config.document.filename}<span className="sr-only"> (opens in a new tab)</span></a>
            <p className="text-xs text-slate-500">{(config.document.size / 1024).toFixed(1)} KB · {config.mode === "pdf" ? "Currently in use" : "Retained, not currently in use"}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy || config.mode === "standard"}
                onClick={() => run("PATCH", { mode: "standard", revision: config.revision }, "Standard help restored. The PDF is retained for later use.")}>Remove PDF from use</Button>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => setConfirmDelete(true)}>Permanently delete PDF</Button>
            </div>
          </div>
        ) : <p className="text-sm text-slate-600">No PDF uploaded. Standard help remains available.</p>}
        <label htmlFor={`badge-pdf-${tenantId}`} className="block text-sm font-medium">{config.document ? "Replace PDF" : "Upload PDF"}</label>
        <Input key={file ? "selected" : "empty"} id={`badge-pdf-${tenantId}`} type="file" accept=".pdf,application/pdf" disabled={busy}
          onChange={(event) => { setFile(event.target.files?.[0] || null); setError(""); setSuccess(""); }} />
        <p className="text-xs text-slate-500">PDF only, up to 2 MB. Uploading replaces the retained document immediately.</p>
        {file && <p className="text-sm break-all">Selected: {file.name}</p>}
        <Button type="button" variant="outline" onClick={upload} disabled={!file || busy}>{reading ? "Reading PDF…" : mutation.isPending ? "Working…" : config.document ? "Upload replacement" : "Upload PDF"}</Button>
      </div>

      {mode === "pdf" && !config.document && <p className="text-sm text-slate-600">Upload a valid PDF before saving Tenant PDF mode.</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error} Your selection and chosen file have been kept.</p>}
      {query.isError && <p role="alert" className="text-sm text-red-700">Could not refresh saved instructions. {query.error.message}</p>}
      {success && <p role="status" className="text-sm text-green-700">{success}</p>}
      {(cleanupWarning || config.warning) && (
        <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
          <p className="text-sm text-amber-900">{cleanupWarning || config.warning}</p>
          <p className="text-sm text-amber-900">Unused files may still count towards storage usage. Retry cleanup without uploading or deleting again.</p>
          <Button type="button" variant="outline" disabled={busy} onClick={() => run("PATCH",
            { mode: config.mode, revision: config.revision }, "Unused file cleanup completed.", true)}>Retry file cleanup</Button>
        </div>
      )}
      {busy && <p role="status" className="text-sm text-slate-600">{reading ? "Preparing your PDF. Please wait." : "Saving badge instructions. Please wait."}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || (mode === "pdf" && !config.document)}
          onClick={() => run("PATCH", { mode, revision: config.revision }, "Badge instructions saved.")}>Save instructions</Button>
        <Button type="button" variant="outline" disabled={busy || query.isFetching} onClick={async () => {
          const result = await query.refetch();
          if (!result.error) { setSelection(null); setError(""); setSuccess("Saved settings reloaded. Your selected file is retained."); }
        }}>Reload saved settings</Button>
      </div>
      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!busy) setConfirmDelete(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permanently delete badge PDF?</DialogTitle>
            <DialogDescription>This deletes {config.document?.filename} and cannot be undone. Members will use the standard help page. To keep the file, cancel and choose “Remove PDF from use” instead.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={async () => {
              if (await run("DELETE", { revision: config.revision, confirm: true }, "PDF permanently deleted. Standard help restored.")) setConfirmDelete(false);
            }}>{busy ? "Deleting…" : "Confirm permanent deletion"}</Button>
          </DialogFooter>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}
