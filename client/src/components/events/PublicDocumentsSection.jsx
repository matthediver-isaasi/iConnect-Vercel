import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FileText, FileIcon, ExternalLink, Eye } from "lucide-react";
import PdfPreviewModal from "./PdfPreviewModal";

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PublicDocumentsSection({ documents, sectionTitle }) {
  const [previewDoc, setPreviewDoc] = useState(null);
  const docs = Array.isArray(documents) ? documents.filter((d) => d && d.url) : [];
  if (docs.length === 0) return null;

  const heading = sectionTitle && sectionTitle.trim() ? sectionTitle.trim() : "Documents";

  const handleOpen = (doc) => {
    const isPdf = (doc.mime_type || "").toLowerCase().includes("pdf");
    if (isPdf) {
      setPreviewDoc(doc);
    } else {
      window.open(doc.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <>
      <div className="space-y-3" data-testid="section-event-documents">
        <h3 className="font-semibold text-slate-900 flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-600" />
          {heading}
        </h3>
        <ul className="space-y-2">
          {docs.map((doc) => {
            const isPdf = (doc.mime_type || "").toLowerCase().includes("pdf");
            const Icon = isPdf ? FileText : FileIcon;
            const label = doc.label || doc.file_name || "Document";
            return (
              <li key={doc.id || doc.url}>
                <button
                  type="button"
                  onClick={() => handleOpen(doc)}
                  className="w-full flex items-center gap-3 p-3 rounded-md border border-slate-200 bg-white text-left hover-elevate active-elevate-2"
                  data-testid={`button-open-document-${doc.id || ''}`}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isPdf ? "text-red-600" : "text-slate-500"}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900 truncate" data-testid={`text-document-label-${doc.id || ''}`}>
                      {label}
                    </p>
                    {(doc.file_name || doc.size) && (
                      <p className="text-xs text-slate-500 truncate">
                        {doc.file_name}
                        {doc.size ? ` • ${formatBytes(doc.size)}` : ""}
                      </p>
                    )}
                  </div>
                  {isPdf ? (
                    <Eye className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  ) : (
                    <ExternalLink className="w-4 h-4 text-slate-400 flex-shrink-0" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <PdfPreviewModal
        open={!!previewDoc}
        onOpenChange={(o) => { if (!o) setPreviewDoc(null); }}
        url={previewDoc?.url}
        label={previewDoc?.label}
        fileName={previewDoc?.file_name}
      />
    </>
  );
}
