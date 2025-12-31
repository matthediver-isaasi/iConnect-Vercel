import { useState, useRef, useEffect } from "react";
import { X, GripHorizontal, Maximize2, Minimize2, Eye, Monitor, Smartphone, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import IEditElementRenderer from "./IEditElementRenderer";

export default function DraggableEditModal({ 
  element, 
  draftContent,
  draftVariant,
  draftSettings,
  onChange,
  onSave, 
  onClose,
  EditorComponent
}) {
  const [position, setPosition] = useState({ x: 100, y: 100 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [isExpanded, setIsExpanded] = useState(false);
  const [previewMode, setPreviewMode] = useState('desktop');
  const [isSaving, setIsSaving] = useState(false);
  
  const modalRef = useRef(null);

  useEffect(() => {
    const savedPosition = sessionStorage.getItem('draggable-modal-position');
    if (savedPosition) {
      try {
        const parsed = JSON.parse(savedPosition);
        setPosition(parsed);
      } catch (e) {
        console.error('Failed to parse saved modal position');
      }
    } else {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      setPosition({
        x: Math.max(20, (viewportWidth - 900) / 2),
        y: Math.max(20, (viewportHeight - 600) / 2)
      });
    }
  }, []);

  useEffect(() => {
    if (position.x > 0 || position.y > 0) {
      sessionStorage.setItem('draggable-modal-position', JSON.stringify(position));
    }
  }, [position]);

  const handleMouseDown = (e) => {
    if (e.target.closest('.modal-drag-handle')) {
      setIsDragging(true);
      const rect = modalRef.current.getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      });
      e.preventDefault();
    }
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (isDragging) {
        const newX = Math.max(0, Math.min(e.clientX - dragOffset.x, window.innerWidth - 400));
        const newY = Math.max(0, Math.min(e.clientY - dragOffset.y, window.innerHeight - 100));
        setPosition({ x: newX, y: newY });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, dragOffset]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave();
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditorChange = (updates) => {
    onChange(updates);
  };

  const elementWithDraft = {
    ...element,
    content: draftContent,
    style_variant: draftVariant,
    settings: draftSettings
  };

  const modalWidth = isExpanded ? 'min-w-[900px] max-w-[95vw]' : 'w-[450px]';
  const modalHeight = isExpanded ? 'h-[85vh]' : 'h-[70vh]';

  return (
    <>
      <div 
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />
      
      <div
        ref={modalRef}
        className={`fixed z-50 bg-white rounded-lg shadow-2xl border border-slate-200 flex flex-col ${modalWidth} ${modalHeight}`}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
          cursor: isDragging ? 'grabbing' : 'auto'
        }}
        onMouseDown={handleMouseDown}
      >
        <div className="modal-drag-handle flex items-center justify-between px-4 py-3 bg-slate-100 border-b border-slate-200 rounded-t-lg cursor-grab select-none">
          <div className="flex items-center gap-3">
            <GripHorizontal className="w-4 h-4 text-slate-400" />
            <span className="font-semibold text-slate-700 capitalize">
              Edit {element?.element_type?.replace(/_/g, ' ')}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs">
              <Eye className="w-3 h-3" />
              Live Edit
            </span>
          </div>
          
          <div className="flex items-center gap-2">
            {isExpanded && (
              <div className="flex items-center gap-1 bg-white rounded-md p-1 mr-2">
                <button
                  onClick={() => setPreviewMode('desktop')}
                  className={`p-1 rounded ${previewMode === 'desktop' ? 'bg-blue-100 text-blue-600' : 'text-slate-500 hover:bg-slate-100'}`}
                  title="Desktop view"
                >
                  <Monitor className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setPreviewMode('mobile')}
                  className={`p-1 rounded ${previewMode === 'mobile' ? 'bg-blue-100 text-blue-600' : 'text-slate-500 hover:bg-slate-100'}`}
                  title="Mobile view"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="h-7 w-7 p-0"
              title={isExpanded ? "Minimize" : "Maximize"}
            >
              {isExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-7 w-7 p-0"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {isExpanded && (
            <div className="flex-1 bg-slate-100 overflow-auto p-4">
              <div className="flex justify-center">
                <div 
                  className="bg-white shadow-lg rounded-lg overflow-hidden transition-all"
                  style={{ 
                    width: previewMode === 'mobile' ? '375px' : '100%',
                    maxWidth: '100%'
                  }}
                >
                  <IEditElementRenderer 
                    element={elementWithDraft}
                    memberInfo={null}
                    organizationInfo={null}
                    isFirst={false}
                    previewViewport={previewMode}
                  />
                </div>
              </div>
            </div>
          )}

          <div className={`${isExpanded ? 'w-[400px] border-l' : 'flex-1'} bg-white overflow-y-auto`}>
            {EditorComponent ? (
              <EditorComponent 
                element={elementWithDraft}
                onClose={onClose}
                onSave={handleEditorChange}
                isInlineMode={true}
                onChange={handleEditorChange}
              />
            ) : (
              <div className="text-center text-slate-500 py-8 px-4">
                <p>Editor not available for this element type.</p>
                <p className="text-sm mt-2">Use the standard editor instead.</p>
              </div>
            )}
          </div>
        </div>

        <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 rounded-b-lg flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            data-testid="button-cancel-inline-edit"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isSaving}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-save-inline-edit"
          >
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </>
  );
}
