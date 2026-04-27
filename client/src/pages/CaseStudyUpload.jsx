import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { Upload, FileText, ImageIcon, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

const MAX_FILE_SIZE = 25 * 1024 * 1024;

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function isImageMime(mime) {
  return typeof mime === "string" && mime.startsWith("image/");
}

export default function CaseStudyUpload() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || "";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [context, setContext] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [uploadingItems, setUploadingItems] = useState([]);
  const fileInputRef = useRef(null);

  const loadContext = useCallback(async () => {
    if (!token) {
      setError("This link is no longer valid");
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await fetch(`/api/public/case-study-upload/context?token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "This link is no longer valid");
      }
      const data = await res.json();
      setContext(data);
      setUploads(data.uploads || []);
      setError(null);
    } catch (err) {
      setError(err.message || "Failed to load");
      setContext(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  const uploadOne = async (file, tempId) => {
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`${file.name} exceeds the 25MB limit`);
    }

    const signedRes = await fetch("/api/public/case-study-upload/signed-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
      }),
    });
    if (!signedRes.ok) {
      const data = await signedRes.json().catch(() => ({}));
      throw new Error(data.error || "Failed to start upload");
    }
    const signedData = await signedRes.json();

    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          setUploadingItems((prev) => prev.map((it) => (it.id === tempId ? { ...it, progress: pct } : it)));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`Upload failed (${xhr.status})`));
      });
      xhr.addEventListener("error", () => reject(new Error("Upload failed")));
      xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));
      xhr.open("PUT", signedData.signedUrl);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.setRequestHeader("x-upsert", "true");
      xhr.send(file);
    });

    const recordRes = await fetch("/api/public/case-study-upload/create-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        storage_path: signedData.path,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
      }),
    });
    if (!recordRes.ok) {
      const data = await recordRes.json().catch(() => ({}));
      throw new Error(data.error || "Failed to record upload");
    }
    const { upload } = await recordRes.json();
    return upload;
  };

  const handleFiles = async (files) => {
    if (!files || files.length === 0) return;
    const tempItems = Array.from(files).map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      progress: 0,
      status: "uploading",
      error: null,
    }));
    setUploadingItems((prev) => [...prev, ...tempItems]);

    for (const item of tempItems) {
      try {
        const upload = await uploadOne(item.file, item.id);
        setUploads((prev) => [upload, ...prev]);
        setUploadingItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, progress: 100, status: "done" } : it)));
        toast.success(`${item.file.name} uploaded`);
        setTimeout(() => {
          setUploadingItems((prev) => prev.filter((it) => it.id !== item.id));
        }, 1500);
      } catch (err) {
        setUploadingItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, status: "error", error: err.message } : it)));
        toast.error(err.message || `Failed to upload ${item.file.name}`);
      }
    }
  };

  const onSelectClick = () => {
    fileInputRef.current?.click();
  };

  const onInputChange = (e) => {
    handleFiles(e.target.files);
    if (e.target) e.target.value = "";
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files?.length) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const tenantPrimaryColor = context?.tenant?.primaryColor || "#5C0085";

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-cs-upload-loading">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading...
        </div>
      </div>
    );
  }

  if (error || !context) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center gap-3 py-6">
              <AlertCircle className="w-10 h-10 text-muted-foreground" />
              <h1 className="text-lg font-semibold" data-testid="text-cs-upload-invalid-title">Link no longer valid</h1>
              <p className="text-sm text-muted-foreground" data-testid="text-cs-upload-invalid-message">
                {error || "This upload link is no longer valid. Please contact the team for a new link."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const providerName = [context.provider?.first_name, context.provider?.last_name].filter(Boolean).join(" ");

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-3">
          {context.tenant?.logoUrl ? (
            <img
              src={context.tenant.logoUrl}
              alt={context.tenant.name || "Logo"}
              className="h-8 w-auto"
              data-testid="img-cs-upload-logo"
            />
          ) : (
            <div
              className="h-8 w-8 rounded-md flex items-center justify-center text-white text-sm font-semibold"
              style={{ backgroundColor: tenantPrimaryColor }}
              data-testid="text-cs-upload-logo-fallback"
            >
              {(context.tenant?.name || "?").charAt(0).toUpperCase()}
            </div>
          )}
          <div className="text-sm font-medium" data-testid="text-cs-upload-tenant-name">
            {context.tenant?.name || ""}
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold" data-testid="text-cs-upload-heading">
            Upload Images & Documents
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-cs-upload-subheading">
            {context.brief?.title ? `For: ${context.brief.title}` : ""}
            {providerName ? ` · ${providerName}` : ""}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="text-case-study-provider-page-status">
            {uploadingItems.length > 0
              ? `Uploading ${uploadingItems.filter((i) => i.status !== "error").length} file(s)...`
              : uploads.length > 0
                ? `${uploads.length} file(s) uploaded`
                : "Ready to receive uploads"}
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="w-4 h-4" />
              Add files
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div
              onClick={onSelectClick}
              onDrop={onDrop}
              onDragOver={onDragOver}
              className="border-2 border-dashed rounded-md p-8 text-center cursor-pointer hover-elevate"
              data-testid="zone-cs-upload-drop"
            >
              <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm font-medium" data-testid="text-cs-upload-cta">
                Click to choose files or drag and drop here
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Images and documents up to 25MB each
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={onInputChange}
              data-testid="input-cs-upload-file"
            />
            <Button
              variant="default"
              onClick={onSelectClick}
              data-testid="button-case-study-provider-upload-submit"
            >
              <Upload className="w-4 h-4" />
              Choose files
            </Button>

            {uploadingItems.length > 0 && (
              <div className="space-y-2 pt-2" data-testid="list-cs-upload-progress">
                {uploadingItems.map((item) => (
                  <div key={item.id} className="space-y-1" data-testid={`item-cs-upload-progress-${item.id}`}>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-medium">{item.file.name}</span>
                      <span className="text-muted-foreground">
                        {item.status === "error" ? item.error : `${item.progress}%`}
                      </span>
                    </div>
                    <Progress value={item.status === "error" ? 0 : item.progress} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Your uploads
            </CardTitle>
          </CardHeader>
          <CardContent>
            {uploads.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-cs-upload-empty">
                No files uploaded yet.
              </p>
            ) : (
              <div className="space-y-2" data-testid="list-cs-upload-items">
                {uploads.map((u) => (
                  <div
                    key={u.id}
                    className="flex items-center gap-3 p-3 border rounded-md"
                    data-testid={`item-cs-upload-${u.id}`}
                  >
                    <div className="flex-shrink-0">
                      {isImageMime(u.mime_type) ? (
                        <ImageIcon className="w-5 h-5 text-muted-foreground" />
                      ) : (
                        <FileText className="w-5 h-5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate" data-testid={`text-cs-upload-name-${u.id}`}>
                        {u.file_name || "Untitled"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        v{u.version_number}
                        {u.file_size ? ` · ${formatBytes(u.file_size)}` : ""}
                        {u.upload_date ? ` · ${formatDate(u.upload_date)}` : ""}
                      </div>
                    </div>
                    <CheckCircle2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
