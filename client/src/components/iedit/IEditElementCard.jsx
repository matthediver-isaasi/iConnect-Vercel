import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GripVertical, Pencil, Copy, Trash2, FileOutput } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function IEditElementCard({ 
  element, 
  isDragging, 
  onEdit, 
  onDelete, 
  onDuplicate,
  onCopyToPage,
  availablePages = [],
  currentPageId
}) {
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState(null);

  const otherPages = availablePages.filter(p => p.id !== currentPageId);

  const handleCopyToPage = () => {
    if (selectedPageId && onCopyToPage) {
      onCopyToPage(element, selectedPageId);
      setShowCopyDialog(false);
      setSelectedPageId(null);
    }
  };

  return (
    <>
      <Card className={`border-slate-200 transition-shadow ${isDragging ? 'shadow-2xl' : 'hover:shadow-md'}`}>
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            {/* Drag Handle */}
            <div className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600">
              <GripVertical className="w-5 h-5" />
            </div>

            {/* Element Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-semibold text-slate-900 capitalize">
                  {element.element_type.replace(/_/g, ' ')}
                </span>
                {element.style_variant && element.style_variant !== 'default' && (
                  <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">
                    {element.style_variant}
                  </span>
                )}
              </div>
              
              {/* Content Preview */}
              <div className="text-sm text-slate-600 truncate">
                {element.content?.heading || element.content?.title || element.content?.text || 'No content'}
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={onEdit}
                className="hover:bg-blue-50 hover:text-blue-700"
                title="Edit"
              >
                <Pencil className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onDuplicate}
                className="hover:bg-slate-100"
                title="Duplicate on this page"
              >
                <Copy className="w-4 h-4" />
              </Button>
              {otherPages.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCopyDialog(true)}
                  className="hover:bg-green-50 hover:text-green-700"
                  title="Copy to another page"
                >
                  <FileOutput className="w-4 h-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onDelete}
                className="hover:bg-red-50 hover:text-red-700"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Copy to Page Dialog */}
      <Dialog open={showCopyDialog} onOpenChange={setShowCopyDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Copy Element to Another Page</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4 mt-4">
            <p className="text-sm text-slate-600">
              Select a page to copy this <strong>{element.element_type.replace(/_/g, ' ')}</strong> element to:
            </p>
            
            <div className="max-h-64 overflow-y-auto space-y-2">
              {otherPages.map((page) => (
                <div
                  key={page.id}
                  className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                    selectedPageId === page.id 
                      ? 'border-blue-500 bg-blue-50' 
                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                  }`}
                  onClick={() => setSelectedPageId(page.id)}
                >
                  <div className="font-medium text-slate-900">{page.title}</div>
                  <div className="text-sm text-slate-500">/{page.slug}</div>
                </div>
              ))}
            </div>

            <div className="flex gap-2 justify-end pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCopyDialog(false);
                  setSelectedPageId(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCopyToPage}
                disabled={!selectedPageId}
              >
                Copy Element
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
