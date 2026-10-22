import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Upload, FileSpreadsheet, AlertCircle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  PUBLICATION_IMPORT_ENDPOINT, validateWorkbook, canApplyPreview,
  displayImportValue, fieldLabel, postPublicationImport, validateImportReceipt,
} from "./publicationImportModel.mjs";

function ResolvedFields({ values }) {
  if (!values || typeof values !== "object") return <p className="text-sm">{displayImportValue(values)}</p>;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {Object.entries(values).map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{fieldLabel(key)}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm">{displayImportValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ImportRows({ rows, final = false }) {
  return (
    <div className="space-y-2" data-testid={final ? "publication-import-results" : "publication-import-preview"}>
      {rows.map((row, index) => (
        <details key={`${row.row ?? index}-${index}`} className="group rounded-md border" open={row.action === "error" || Boolean(row.errors?.length)}>
          <summary className="cursor-pointer p-3 text-sm marker:text-muted-foreground">
            <span className="ml-1 font-medium">Row {row.row ?? index + 1}: {row.title || row.payload?.title || "Untitled publication"}</span>
            <Badge className="ml-2" variant={row.action === "error" || row.errors?.length ? "destructive" : "secondary"}>
              {row.action || row.status || (final ? "Result" : "Review")}
            </Badge>
            {row.warnings?.length > 0 && <span className="ml-2 text-xs text-muted-foreground">{row.warnings.length} warnings</span>}
          </summary>
          <div className="space-y-4 border-t bg-muted/20 p-4">
            {row.errors?.length > 0 && <div className="text-sm text-destructive" role="alert">
              <p className="font-medium">Correct this row in your workbook</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">{row.errors.map((error, i) => <li key={i}>{displayImportValue(error)}</li>)}</ul>
            </div>}
            {row.warnings?.length > 0 && <div className="text-sm">
              <p className="font-medium">Review before importing</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">{row.warnings.map((warning, i) => <li key={i}>{displayImportValue(warning)}</li>)}</ul>
            </div>}
            {row.error && <p className="text-sm text-destructive">{displayImportValue(row.error)}</p>}
            {row.message && <p className="text-sm">{displayImportValue(row.message)}</p>}
            {!final && <>
              <div><p className="mb-1 text-xs text-muted-foreground">Resolved writer</p><p className="break-words text-sm">{displayImportValue(row.writer)}</p></div>
              <div><p className="mb-1 text-xs text-muted-foreground">Resolved editor</p><p className="break-words text-sm">{displayImportValue(row.editor)}</p></div>
              <ResolvedFields values={row.payload} />
            </>}
            {final && <ResolvedFields values={Object.fromEntries(Object.entries(row).filter(([key]) => !["row", "title", "action", "status", "errors", "warnings", "message", "error"].includes(key)))} />}
          </div>
        </details>
      ))}
    </div>
  );
}

// No workbook, personal data, or plan token is persisted in browser storage.
// Closing the dialog retains the token in memory; identity changes remount it.
export default function PublicationImportControls({ canManage = false, tenantId, actorId }) {
  if (!canManage) return null;
  return <PublicationImportWorkflow key={`${tenantId ?? "current-tenant"}:${actorId ?? "current-actor"}`} />;
}

function PublicationImportWorkflow() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [workbook, setWorkbook] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [applyAttempted, setApplyAttempted] = useState(false);
  // Synchronous lock prevents duplicate submits before React commits state.
  const requestLock = useRef(false);
  const fileInput = useRef(null);
  const eligible = canApplyPreview(preview);
  const counts = { create: 0, skip: 0, error: 0 };
  for (const row of preview?.rows || []) if (row.action in counts) counts[row.action]++;

  async function downloadTemplate() {
    setDownloading(true);
    try {
      const response = await fetch(`${PUBLICATION_IMPORT_ENDPOINT}?action=template`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not download the template. Please try again.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "publication-import-template.xlsx";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err.message || "Could not download the template.");
    } finally {
      setDownloading(false);
    }
  }

  function reset() {
    setFile(null);
    setWorkbook("");
    setSheetName("");
    setPreview(null);
    setResult(null);
    setConfirmed(false);
    setError("");
    setApplyAttempted(false);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function selectFile(event) {
    const selected = event.target.files?.[0];
    if (!selected || requestLock.current) return;
    reset();
    const invalid = validateWorkbook(selected);
    if (invalid) { setError(invalid); return; }
    setFile(selected);
    setBusy("reading");
    requestLock.current = true;
    try {
      const encoded = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read the workbook. Choose the file again."));
        reader.onabort = () => reject(new Error("Reading was interrupted. Choose the file again."));
        reader.readAsDataURL(selected);
      });
      setWorkbook(encoded);
    } catch (err) {
      setError(err.message);
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }

  async function generatePreview() {
    if (requestLock.current || !file || !workbook || applyAttempted) return;
    requestLock.current = true;
    setBusy("preview");
    setError("");
    setConfirmed(false);
    setPreview(null);
    try {
      const data = await postPublicationImport({ action: "preview", fileName: file.name, workbook, ...(sheetName ? { sheetName } : {}) });
      setPreview(data);
      setSheetName(data.sheetName || "");
    } catch (err) {
      setError(err.message || "Preview failed. Try again.");
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }

  async function applyImport() {
    if (requestLock.current || !eligible || !confirmed || result?.done) return;
    const planId = preview.planId; // Never replace this token during a retry.
    requestLock.current = true;
    setApplyAttempted(true);
    setBusy("apply");
    setError("");
    try {
      const data = await postPublicationImport({ action: "apply", planId });
      if (!validateImportReceipt(data, preview.rows.length)) {
        throw new Error("The server returned an incomplete or invalid import receipt.");
      }
      setResult(data);
      if (!data.done) {
        setError("The import has not finished. Retry this import to resume with the same plan.");
      } else {
        void queryClient.invalidateQueries({ queryKey: ["article-briefs"] });
        // Discard the workbook after completion; preserve results until dismissed.
        setWorkbook("");
      }
    } catch (err) {
      if (err.definitive) {
        setApplyAttempted(false);
        setConfirmed(false);
        setResult(null);
        setPreview(current => ({ ...current, planId: null, canApply: false }));
        setError(`${err.message} This plan was rejected. Correct the workbook or restore your access, then preview it again before confirming a new plan.`);
      } else {
        setError(`${err.message || "The connection was interrupted."} The outcome may be incomplete. Retry this import with the same plan; do not upload it again.`);
      }
    } finally {
      requestLock.current = false;
      setBusy("");
    }
  }

  const done = result?.done === true;
  return <>
    <Button variant="outline" onClick={downloadTemplate} disabled={downloading} data-testid="button-download-publication-template">
      <Download className="mr-2 h-4 w-4" />{downloading ? "Downloading…" : "Download template"}
    </Button>
    <Button variant="outline" onClick={() => setOpen(true)} data-testid="button-import-publications">
      <Upload className="mr-2 h-4 w-4" />{applyAttempted && !done ? "Resume publication import" : "Import publications"}
    </Button>
    <Dialog open={open} onOpenChange={value => { if (!requestLock.current) setOpen(value); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl overflow-y-auto" hideCloseButton={Boolean(busy)}
        onEscapeKeyDown={event => { if (requestLock.current) event.preventDefault(); }}
        onPointerDownOutside={event => { if (requestLock.current) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Import publications</DialogTitle>
          <DialogDescription>Upload a workbook, review every row, then confirm the import. Maximum 1 MB and 100 rows.</DialogDescription>
        </DialogHeader>
        <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-sm">
          This import only creates new article briefs. Existing briefs are not updated. No emails are sent and no public resources are created.
        </div>
        {!done && <div className="space-y-4">
          <div className="rounded-md border p-4">
            <Label htmlFor="publication-import-file" className="flex items-center gap-2"><FileSpreadsheet className="h-4 w-4" />Publication workbook</Label>
            <Input ref={fileInput} id="publication-import-file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="mt-3" onChange={selectFile} disabled={Boolean(busy) || applyAttempted} />
            <p className="mt-2 text-xs text-muted-foreground">{file?.name || "Use the template headers. Correct issues in your spreadsheet, then upload the corrected workbook."}</p>
          </div>
          {preview?.sheets?.length > 0 && <div className="space-y-2">
            <Label htmlFor="publication-import-sheet">Worksheet</Label>
            <select id="publication-import-sheet" className="flex h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={sheetName} disabled={Boolean(busy) || applyAttempted}
              onChange={event => { setSheetName(event.target.value); setPreview(current => ({ sheets: current.sheets })); setConfirmed(false); setError(""); }}>
              <option value="">Choose a worksheet</option>
              {preview.sheets.map(sheet => {
                const name = typeof sheet === "string" ? sheet : sheet.name || sheet.sheetName;
                return <option key={name} value={name}>{name}</option>;
              })}
            </select>
            {preview.needsSheetSelection && <p className="text-sm text-muted-foreground">Choose the worksheet containing publications, then preview it.</p>}
          </div>}
          {!applyAttempted && <Button variant="outline" disabled={!workbook || Boolean(busy) || (Boolean(preview?.sheets?.length) && !sheetName)} onClick={generatePreview}
            data-testid="button-preview-publication-import">Preview {sheetName ? "worksheet" : "workbook"}</Button>}
        </div>}
        {busy && <div role="status" aria-live="polite" className="space-y-3 rounded-md border p-4">
          <p className="text-sm font-medium">{busy === "apply" ? "Creating publications. Please keep this window open…" : busy === "reading" ? "Reading workbook…" : "Checking rows and resolving assignments…"}</p>
          <Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-2/3" />
        </div>}
        {error && <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><p>{error}</p>
        </div>}
        {!done && preview?.rows && <section className="space-y-3" aria-label="Publication import preview">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">Review resolved data</h3>
            <Badge variant="secondary">{counts.create} to create</Badge>
            <Badge variant="secondary">{counts.skip} to skip</Badge>
            <Badge variant={counts.error ? "destructive" : "secondary"}>{counts.error} invalid</Badge>
          </div>
          <p className="text-xs text-muted-foreground">Expand each row to check all resolved fields, contributor details, assignments, dates and requirements.</p>
          {!preview.rows.length ? <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">No publication rows found. Check the selected worksheet and template headers.</p> : <ImportRows rows={preview.rows} />}
          {!eligible && <p className="rounded-md border p-3 text-sm text-destructive">This preview cannot be applied. Correct all errors in the workbook and upload it again, or choose the correct worksheet. Skipped rows will not be changed.</p>}
          {eligible && <label className="flex cursor-pointer items-start gap-3 rounded-md border bg-muted/20 p-4 text-sm">
            <Checkbox checked={confirmed} onCheckedChange={value => setConfirmed(value === true)} disabled={Boolean(busy) || applyAttempted}
              aria-label="Confirm publication import" className="mt-0.5" />
            <span>I have reviewed the resolved data and warnings. Create {counts.create} new {counts.create === 1 ? "brief" : "briefs"} and skip {counts.skip} rows. No emails will be sent.</span>
          </label>}
        </section>}
        {result && <section className="space-y-4" aria-live="polite">
          <div className="rounded-md border bg-primary/5 p-4">
            <h3 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-5 w-5" />{done ? "Import complete" : "Import progress"}</h3>
            <dl className="mt-4 grid grid-cols-3 gap-3">
              {["created", "skipped", "failed"].map(key => <div key={key}><dt className="text-xs text-muted-foreground">{fieldLabel(key)}</dt><dd className="text-2xl font-semibold">{result[key] ?? 0}</dd></div>)}
            </dl>
          </div>
          {done && Number(result.failed) > 0 && <p className="text-sm text-destructive">Review failed rows below. Correct only those rows before starting another import.</p>}
          {result.rows?.length > 0 && <ImportRows rows={result.rows} final />}
        </section>}
        {applyAttempted && !done && <p className="text-xs text-muted-foreground">The current plan is retained while this page is open, even if you close this dialog. Retry uses the same plan to avoid duplicate creation. Reloading this page discards it.</p>}
        <DialogFooter className="gap-2">
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => setOpen(false)}>{done ? "Close" : "Close for now"}</Button>
          {done ? <Button onClick={reset}>Start another import</Button> :
            <Button onClick={applyImport} disabled={Boolean(busy) || !eligible || !confirmed} data-testid="button-apply-publication-import">
              {busy === "apply" ? "Importing…" : applyAttempted ? "Retry same import" : `Import ${counts.create} publications`}
            </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
