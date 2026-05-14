import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, Save, Eye, EyeOff, Settings,
  Monitor, Tablet, Smartphone, MousePointer2,
} from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useNavigate } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import {
  createEmptyCanvasDesign,
  normalizeCanvasDesign,
} from "@/lib/canvasDesign";

// Canvas Builder Phase 1 — Editor shell.
// No working blocks yet; this scaffolds the toolbar, palette stub,
// free-form canvas stage, and inspector so subsequent phases can plug in
// block types, drag/drop, breakpoint overrides, etc.

const BREAKPOINTS = [
  { id: 'desktop', label: 'Desktop', icon: Monitor, width: '100%' },
  { id: 'tablet', label: 'Tablet', icon: Tablet, width: '768px' },
  { id: 'mobile', label: 'Mobile', icon: Smartphone, width: '375px' },
];

export default function CanvasPageEditorPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [pageId, setPageId] = useState(null);
  const [design, setDesign] = useState(() => createEmptyCanvasDesign());
  const [isDirty, setIsDirty] = useState(false);
  const [breakpoint, setBreakpoint] = useState('desktop');
  const [showPreview, setShowPreview] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.page-editor')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('pageId');
    if (id) {
      setPageId(id);
    } else {
      toast.error('No page ID provided');
      navigate(createPageUrl('IEditPageManagement'));
    }
  }, [navigate]);

  const { data: page, isLoading: pageLoading } = useQuery({
    queryKey: ['canvas-page', pageId],
    queryFn: async () => {
      // Read through the dedicated tenant-hard-fail Canvas endpoint so
      // canvas-specific authorization stays centralized in one place.
      const resp = await fetch(`/api/canvas-design/${encodeURIComponent(pageId)}`, {
        credentials: 'include',
      });
      if (resp.status === 404) return null;
      // 409 = page exists but uses a different builder. Surface this as a
      // distinct state so the editor can redirect to IEditPageEditor
      // instead of showing a generic "not found".
      if (resp.status === 409) return { __wrongBuilder: true, id: pageId };
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || `Failed to load page (${resp.status})`);
      }
      const body = await resp.json();
      return body.page || null;
    },
    enabled: !!pageId,
    staleTime: 0,
  });

  useEffect(() => {
    if (page && page.__wrongBuilder) {
      navigate(createPageUrl('IEditPageEditor') + `?pageId=${page.id}`, { replace: true });
      return;
    }
    if (page) {
      setDesign(normalizeCanvasDesign(page.canvas_design));
      // If the page was created without a canvas_design row value (e.g. the
      // create flow couldn't insert the jsonb default), surface it as dirty
      // so the author can persist an initial empty design with one click.
      // Otherwise treat the freshly-loaded design as clean.
      const needsInitialPersist = !page.canvas_design || typeof page.canvas_design !== 'object';
      setIsDirty(needsInitialPersist);
    }
  }, [page]);

  // Canvas design writes go through the dedicated /api/canvas-design
  // endpoint so authorization and validation stay in one place.
  const saveDesignMutation = useMutation({
    mutationFn: async ({ id, canvasDesign }) => {
      const resp = await fetch(`/api/canvas-design/${encodeURIComponent(id)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvas_design: canvasDesign }),
      });
      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error(errBody.error || `Failed to save (${resp.status})`);
      }
      return resp.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvas-page', pageId] });
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      setIsDirty(false);
      setPreviewNonce((n) => n + 1);
      toast.success('Page saved');
    },
    onError: (error) => {
      toast.error('Failed to save: ' + (error?.message || 'Unknown error'));
    },
  });

  // Non-design page metadata (status / published_at) still flows through
  // the generic entity API which already enforces tenant context.
  const updatePageMetaMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.IEditPage.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['canvas-page', pageId] });
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      setPreviewNonce((n) => n + 1);
      toast.success('Page updated');
    },
    onError: (error) => {
      toast.error('Failed to update: ' + (error?.message || 'Unknown error'));
    },
  });

  const handleSave = () => {
    if (!pageId) return;
    saveDesignMutation.mutate({ id: pageId, canvasDesign: design });
  };

  const handleTogglePublish = async () => {
    if (!page) return;
    const newStatus = page.status === 'published' ? 'draft' : 'published';
    if (isDirty) {
      try {
        await saveDesignMutation.mutateAsync({ id: pageId, canvasDesign: design });
      } catch {
        return;
      }
    }
    updatePageMetaMutation.mutate({
      id: pageId,
      data: {
        status: newStatus,
        published_at: newStatus === 'published' ? new Date().toISOString() : null,
      },
    });
  };

  const stageWidth = useMemo(
    () => BREAKPOINTS.find((b) => b.id === breakpoint)?.width || '100%',
    [breakpoint],
  );

  if (!accessChecked || pageLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="loading-canvas-editor">
        <div className="text-slate-600">Loading…</div>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="min-h-screen flex items-center justify-center" data-testid="canvas-editor-not-found">
        <div className="text-center">
          <p className="text-slate-600 mb-4">Page not found.</p>
          <Button onClick={() => navigate(createPageUrl('IEditPageManagement'))} data-testid="button-back-to-pages">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to pages
          </Button>
        </div>
      </div>
    );
  }

  if (page.builder_type !== 'canvas') {
    return (
      <div className="min-h-screen flex items-center justify-center px-4" data-testid="canvas-editor-wrong-builder">
        <div className="text-center max-w-md">
          <p className="text-slate-700 mb-4">
            This page uses the iEdit builder. Open it in the iEdit editor instead.
          </p>
          <Button
            onClick={() => navigate(createPageUrl('IEditPageEditor') + `?pageId=${page.id}`)}
            data-testid="button-open-in-iedit"
          >
            Open in iEdit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-100" data-testid="canvas-page-editor">
      {/* Toolbar */}
      <header className="sticky top-0 z-50 bg-white border-b border-slate-200 px-4 py-2 flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(createPageUrl('IEditPageManagement'))}
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Pages
        </Button>

        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900 truncate" data-testid="text-page-title">
              {page.title}
            </span>
            <Badge variant="outline" data-testid="badge-builder-type">Canvas</Badge>
            <Badge
              className={page.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'}
              data-testid="badge-page-status"
            >
              {page.status}
            </Badge>
            {isDirty && (
              <Badge className="bg-amber-100 text-amber-700" data-testid="badge-unsaved">
                Unsaved
              </Badge>
            )}
          </div>
          <span className="text-xs text-slate-500 truncate">/{page.slug}</span>
        </div>

        <div className="flex-1" />

        {/* Breakpoint switcher */}
        <div className="inline-flex rounded-md border border-slate-200 bg-white" role="group" aria-label="Preview breakpoint">
          {BREAKPOINTS.map((bp) => {
            const Icon = bp.icon;
            const active = bp.id === breakpoint;
            return (
              <Button
                key={bp.id}
                variant="ghost"
                size="sm"
                className={`rounded-none toggle-elevate ${active ? 'toggle-elevated' : ''}`}
                onClick={() => setBreakpoint(bp.id)}
                aria-pressed={active}
                aria-label={bp.label}
                data-testid={`button-breakpoint-${bp.id}`}
              >
                <Icon className="w-4 h-4" />
              </Button>
            );
          })}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowPreview((v) => !v)}
          data-testid="button-toggle-preview"
          aria-pressed={showPreview}
        >
          {showPreview ? <EyeOff className="w-4 h-4 mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
          {showPreview ? 'Hide preview' : 'Show preview'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleTogglePublish}
          disabled={saveDesignMutation.isPending || updatePageMetaMutation.isPending}
          data-testid="button-toggle-publish"
        >
          {page.status === 'published' ? 'Unpublish' : 'Publish'}
        </Button>

        <Button
          size="sm"
          onClick={handleSave}
          disabled={saveDesignMutation.isPending || !isDirty}
          data-testid="button-save"
        >
          <Save className="w-4 h-4 mr-2" />
          Save
        </Button>
      </header>

      {/* Body: palette | stage | inspector | preview */}
      <div className="flex-1 flex min-h-0">
        {/* Left palette stub */}
        <aside
          className="w-60 border-r border-slate-200 bg-white p-3 overflow-y-auto"
          aria-label="Block palette"
          data-testid="panel-palette"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-900">Blocks</h2>
          </div>
          <p className="text-xs text-slate-500" data-testid="text-palette-stub">
            Block types are coming in a later phase. Drag-and-drop will land
            here once the foundation is in place.
          </p>
        </aside>

        {/* Stage */}
        <main className="flex-1 overflow-auto p-6 flex justify-center" data-testid="panel-stage">
          <div
            className="bg-white shadow-sm border border-slate-200 transition-all"
            style={{ width: stageWidth, maxWidth: '100%', minHeight: '60vh' }}
            data-testid={`stage-${breakpoint}`}
            data-breakpoint={breakpoint}
          >
            <CanvasStage design={design} breakpoint={breakpoint} />
          </div>
        </main>

        {/* Right inspector stub */}
        <aside
          className="w-72 border-l border-slate-200 bg-white p-3 overflow-y-auto"
          aria-label="Inspector"
          data-testid="panel-inspector"
        >
          <div className="flex items-center gap-2 mb-3">
            <Settings className="w-4 h-4 text-slate-500" />
            <h2 className="text-sm font-semibold text-slate-900">Inspector</h2>
          </div>
          <p className="text-xs text-slate-500" data-testid="text-inspector-stub">
            Selected-block properties (position, breakpoint overrides,
            accessibility) will appear here in a later phase.
          </p>
        </aside>

        {/* Side-by-side iframe preview (reloads after Save). The iframe
            renders the real public route, so what authors see here matches
            what visitors will see. */}
        {showPreview && (
          <aside
            className="w-[420px] border-l border-slate-200 bg-slate-50 flex flex-col"
            aria-label="Live preview"
            data-testid="panel-preview"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 bg-white">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-slate-500" />
                <span className="text-sm font-semibold text-slate-900">Preview</span>
                {isDirty && (
                  <Badge className="bg-amber-100 text-amber-700" data-testid="badge-preview-stale">
                    Save to refresh
                  </Badge>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPreviewNonce((n) => n + 1)}
                data-testid="button-refresh-preview"
              >
                Refresh
              </Button>
            </div>
            <div className="flex-1 overflow-hidden">
              {page.slug ? (
                <iframe
                  key={previewNonce}
                  title="Page preview"
                  src={`/${page.slug}?_canvasPreview=${previewNonce}`}
                  className="w-full h-full border-0 bg-white"
                  data-testid="iframe-preview"
                />
              ) : (
                <div className="p-4 text-sm text-slate-500" data-testid="text-preview-no-slug">
                  Save a slug for this page before previewing.
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// Free-form canvas stage. Phase 1 is empty — rulers/guides and block
// rendering will be added in later phases.
function CanvasStage({ design, breakpoint }) {
  const d = normalizeCanvasDesign(design);
  const isEmpty = d.root.sections.length === 0;

  return (
    <div
      className="relative w-full h-full min-h-[60vh]"
      data-testid="canvas-stage"
      data-breakpoint={breakpoint}
    >
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Card className="px-6 py-8 text-center bg-slate-50 border-dashed">
            <MousePointer2 className="w-8 h-8 text-slate-400 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-700 mb-1">
              Empty canvas
            </p>
            <p className="text-xs text-slate-500 max-w-xs">
              Block types and drag-and-drop will be added in a later phase.
              For now this page is a foundation only.
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
