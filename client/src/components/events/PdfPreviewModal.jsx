import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ExternalLink, Download } from "lucide-react";

export default function PdfPreviewModal({ open, onOpenChange, url, label, fileName }) {
  if (!url) return null;
  const displayTitle = label || fileName || "Document";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[95vw] h-[90vh] p-0 flex flex-col gap-0">
        <DialogHeader className="px-6 py-4 border-b flex flex-row items-center justify-between gap-3 space-y-0">
          <DialogTitle className="text-base truncate" data-testid="text-pdf-preview-title">
            {displayTitle}
          </DialogTitle>
          <div className="flex items-center gap-2 pr-6">
            <Button
              variant="outline"
              size="sm"
              asChild
              data-testid="button-pdf-open-new-tab"
            >
              <a href={url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-4 h-4 mr-2" />
                Open in new tab
              </a>
            </Button>
            <Button
              variant="outline"
              size="sm"
              asChild
              data-testid="button-pdf-download"
            >
              <a href={url} download={fileName || undefined}>
                <Download className="w-4 h-4 mr-2" />
                Download
              </a>
            </Button>
          </div>
        </DialogHeader>
        <div className="flex-1 bg-slate-100 overflow-hidden">
          <iframe
            src={url}
            title={displayTitle}
            className="w-full h-full border-0"
            data-testid="iframe-pdf-preview"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
