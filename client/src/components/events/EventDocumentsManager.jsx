import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { uploadFileWithProgress, UPLOAD_TYPES } from "@/lib/tenantUpload";
import { FileText, FileIcon, Upload, X, ArrowUp, ArrowDown, Loader2 } from "lucide-react";

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function EventDocumentsManager({
  sectionTitle,
  onSectionTitleChange,
  documents,
  onDocumentsChange,
  entityId = null,
}) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const docs = Array.isArray(documents) ? documents : [];

  const update = (next) => onDocumentsChange(next);

  const handleFilePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setProgress(0);
    try {
      const result = await uploadFileWithProgress(file, {
        type: UPLOAD_TYPES.PAGE,
        entityId,
        onProgress: setProgress,
      });
      const entry = {
        id: newId(),
        label: file.name.replace(/\.[^.]+$/, ""),
        url: result.file_url,
        file_name: result.file_name,
        mime_type: result.mime_type,
        size: result.file_size,
      };
      update([...docs, entry]);
      toast.success("Document uploaded");
    } catch (err) {
      console.error("[EventDocumentsManager] upload error:", err);
      showUploadErrorToast(err, "Failed to upload document");
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  const updateLabel = (id, label) => {
    update(docs.map((d) => (d.id === id ? { ...d, label } : d)));
  };

  const removeDoc = (id) => {
    update(docs.filter((d) => d.id !== id));
  };

  const move = (id, direction) => {
    const idx = docs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= docs.length) return;
    const next = [...docs];
    [next[idx], next[target]] = [next[target], next[idx]];
    update(next);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="documents-section-title">Section title</Label>
        <Input
          id="documents-section-title"
          value={sectionTitle || ""}
          onChange={(e) => onSectionTitleChange(e.target.value)}
          placeholder='e.g. "Programmes" or "Event Documents"'
          data-testid="input-documents-section-title"
        />
        <p className="text-xs text-slate-500">
          Heading shown above the documents list on the public event page. Defaults to &quot;Documents&quot; when blank.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Documents</Label>
        {docs.length === 0 ? (
          <p className="text-xs text-slate-500" data-testid="text-no-documents">
            No documents added yet. Upload PDFs, slide decks, or other files attendees should see.
          </p>
        ) : (
          <div className="space-y-2">
            {docs.map((doc, idx) => {
              const isPdf = (doc.mime_type || "").toLowerCase().includes("pdf");
              const Icon = isPdf ? FileText : FileIcon;
              return (
                <div
                  key={doc.id}
                  className="flex items-start gap-2 p-3 rounded-md border border-slate-200 bg-white"
                  data-testid={`row-document-${doc.id}`}
                >
                  <Icon className={`w-5 h-5 mt-2 flex-shrink-0 ${isPdf ? "text-red-600" : "text-slate-500"}`} />
                  <div className="flex-1 min-w-0 space-y-1">
                    <Input
                      value={doc.label || ""}
                      onChange={(e) => updateLabel(doc.id, e.target.value)}
                      placeholder="Display label"
                      data-testid={`input-document-label-${doc.id}`}
                    />
                    <p className="text-xs text-slate-500 truncate">
                      {doc.file_name}
                      {doc.size ? ` • ${formatBytes(doc.size)}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => move(doc.id, "up")}
                      disabled={idx === 0}
                      data-testid={`button-document-up-${doc.id}`}
                    >
                      <ArrowUp className="w-4 h-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => move(doc.id, "down")}
                      disabled={idx === docs.length - 1}
                      data-testid={`button-document-down-${doc.id}`}
                    >
                      <ArrowDown className="w-4 h-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => removeDoc(doc.id)}
                      data-testid={`button-document-remove-${doc.id}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFilePicked}
          data-testid="input-document-file"
        />
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            data-testid="button-upload-document"
          >
            {uploading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Upload document
              </>
            )}
          </Button>
          {uploading && (
            <div className="flex-1 max-w-xs">
              <Progress value={progress} />
            </div>
          )}
        </div>
        <p className="text-xs text-slate-500">
          Files are stored as public assets (max 10 MB). PDFs open in an in-page preview; other types open in a new tab.
        </p>
      </div>
    </div>
  );
}
