import React, { useState, useEffect, useCallback, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft, Save, Eye,
  Monitor, Tablet, Smartphone,
  Accessibility, Loader2,
  LayoutTemplate, Component as ComponentIcon, History as HistoryIcon,
  Images as ImagesIcon, Palette, Keyboard, Command as CommandIcon, ExternalLink,
  Unlink,
} from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useNavigate } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import {
  createEmptyCanvasDesign,
  normalizeCanvasDesign,
  validateCanvasDesign,
} from "@/lib/canvasDesign";
import { auditCanvasDesign, getBlockingIssues } from "@/lib/canvasA11y";
import CanvasBuilder from "@/components/canvas/CanvasBuilder";
import {
  TemplatesDialog, SymbolsDialog, VersionsDialog, MediaLibraryDialog,
  ThemeDialog, ShortcutsOverlay, CommandPalette, unlinkSelectedSymbol,
} from "@/components/canvas/CanvasPhase7Dialogs";

// Canvas Builder Phase 2 — Editor shell wraps the CanvasBuilder.
// Handles loading, saving (manual + autosave), and previewing the page.

const BREAKPOINTS = [
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
];

export default function CanvasPageEditorPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [pageId, setPageId] = useState(null);
  const [initialDesign, setInitialDesign] = useState(() => createEmptyCanvasDesign());
  const [isDirty, setIsDirty] = useState(false);
  const canvasRef = useRef(null);
  const [breakpoint, setBreakpoint] = useState('desktop');
  // The live preview + audit iframe used to live in a fixed 420px side
  // panel, which was useless on large desktops and made the axe-core
  // scan run against a layout the visitor never sees. It now lives in a
  // centred modal sized to the selected breakpoint (or up to the
  // viewport on desktop), and is the single host for `previewIframeRef`.
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  // Phase 7 dialog visibility flags. The command palette and shortcut
  // overlay are toggled via global keyboard shortcuts (Cmd+K and ?).
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [previewAsVisitor, setPreviewAsVisitor] = useState(false);
  // Picker callback for the media library dialog. When a block inspector
  // requests the library, we capture its onPick so the dialog can hand
  // the selected asset back through this single channel.
  const [mediaPickHandler, setMediaPickHandler] = useState(null);
  // Phase 7 — block inspectors can ask the library to be filtered down
  // to image- or video-only assets (e.g. the video block).
  const [mediaPickKind, setMediaPickKind] = useState(null);
  // Loaded for the command palette's "jump to page" entries. Cheap to
  // fetch alongside the editor and reused by the picker UI.
  const { data: allPages } = useQuery({
    queryKey: ['iedit-pages'],
    queryFn: () => base44.entities.IEditPage.list(),
    staleTime: 30_000,
  });
  const previewIframeRef = useRef(null);
  const [axeIssues, setAxeIssues] = useState(null); // null = never run
  const [axeRunning, setAxeRunning] = useState(false);
  const [axeStale, setAxeStale] = useState(false);
  const [axeLastRunAt, setAxeLastRunAt] = useState(null);
  // Track whether the design has changed since the last axe run so the user
  // knows the previous result may be stale.
  const lastAxeDesignRef = useRef(null);
  // Set to true when a save has just bumped the preview iframe; the iframe's
  // onLoad handler will then trigger an automatic axe run.
  const autoAuditPendingRef = useRef(false);

  // Wrap dirty-change so any edit after an axe run marks the result stale.
  const handleDirtyChange = useCallback((nextDirty) => {
    setIsDirty(nextDirty);
    if (nextDirty) setAxeStale((prev) => prev || !!axeIssues);
  }, [axeIssues]);

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
      const resp = await fetch(`/api/canvas-design/${encodeURIComponent(pageId)}`, {
        credentials: 'include',
      });
      if (resp.status === 404) return null;
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

  // Hydrate local editor state only on first load per pageId. Subsequent
  // refetches (e.g. after a successful save invalidates the query) must
  // NOT clobber the in-memory design, or autosave would wipe undo/redo
  // history and reset uncommitted edits.
  const hydratedPageIdRef = useRef(null);
  useEffect(() => {
    if (page && page.__wrongBuilder) {
      navigate(createPageUrl('IEditPageEditor') + `?pageId=${page.id}`, { replace: true });
      return;
    }
    if (page && hydratedPageIdRef.current !== page.id) {
      setInitialDesign(normalizeCanvasDesign(page.canvas_design));
      const needsInitialPersist = !page.canvas_design || typeof page.canvas_design !== 'object';
      setIsDirty(needsInitialPersist);
      hydratedPageIdRef.current = page.id;
    }
  }, [page, navigate]);

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
      // The iframe will reload on the nonce bump; if the preview modal is
      // open, queue an automatic axe re-run for when it finishes loading.
      if (showAuditModal) {
        autoAuditPendingRef.current = true;
      }
    },
    onError: (error) => {
      toast.error('Failed to save: ' + (error?.message || 'Unknown error'));
    },
  });

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

  // Returns a Promise so CanvasBuilder can only clear the dirty marker
  // after the save actually succeeded. CanvasBuilder is the source of
  // truth for the in-flight design; we just route it to the API.
  const handleSave = useCallback((nextDesign) => {
    if (!pageId) return Promise.resolve();
    return saveDesignMutation.mutateAsync({ id: pageId, canvasDesign: nextDesign });
  }, [pageId, saveDesignMutation]);

  const handleManualSave = async () => {
    if (!pageId || !canvasRef.current) return;
    const ok = await canvasRef.current.saveNow();
    if (ok) toast.success('Page saved');
  };

  const handleTogglePublish = async () => {
    if (!page) return;
    const newStatus = page.status === 'published' ? 'draft' : 'published';

    // Block publishing pages that contain blocks with required fields
    // missing. Surface every failing block in a toast so the author can
    // fix them before retrying.
    if (newStatus === 'published') {
      const designToCheck = canvasRef.current?.getDesign?.() || page.canvas_design;
      const issues = validateCanvasDesign(designToCheck);
      if (issues.length > 0) {
        const summary = issues
          .slice(0, 5)
          .map((i) => `• ${i.blockName || i.blockType}: ${i.errors[0]}`)
          .join('\n');
        const more = issues.length > 5 ? `\n…and ${issues.length - 5} more` : '';
        toast.error(`Can't publish — ${issues.length} block(s) need attention:\n${summary}${more}`, {
          duration: 8000,
        });
        return;
      }

      // Accessibility "must-fix" issues block publishing too. Combine the
      // in-process heuristic audit with the last axe-core scan against the
      // rendered preview (if any).
      const a11yIssues = auditCanvasDesign(designToCheck);
      // Only consider axe results if they were produced from the current
      // design. Stale results would unfairly block publishing after fixes.
      const axeBlocking = (!axeStale && axeIssues)
        ? axeIssues.filter((i) => i.severity === 'error')
        : [];
      const blocking = [...getBlockingIssues(a11yIssues), ...axeBlocking];
      // If we've never run a full audit, or the last run is stale, force a
      // fresh axe scan before allowing publish so authors get the most
      // accurate picture against the rendered preview.
      if (axeIssues === null || axeStale) {
        toast.error(
          axeIssues === null
            ? 'Run the full accessibility audit before publishing.'
            : 'Accessibility audit results are stale — run the full audit again before publishing.',
          { duration: 8000 },
        );
        return;
      }
      if (blocking.length > 0) {
        const summary = blocking
          .slice(0, 5)
          .map((i) => `• ${i.blockName ? `${i.blockName}: ` : ''}${i.message}`)
          .join('\n');
        const more = blocking.length > 5 ? `\n…and ${blocking.length - 5} more` : '';
        toast.error(
          `Can't publish — ${blocking.length} accessibility issue(s) must be fixed:\n${summary}${more}`,
          { duration: 10000 },
        );
        return;
      }
    }

    if (canvasRef.current?.isDirty?.()) {
      const ok = await canvasRef.current.saveNow();
      if (!ok) return;
    }

    updatePageMetaMutation.mutate({
      id: pageId,
      data: {
        status: newStatus,
        published_at: newStatus === 'published' ? new Date().toISOString() : null,
      },
    });

    // Snapshot on publish so authors can roll back. Best-effort — failure
    // here doesn't block publishing.
    if (newStatus === 'published') {
      try {
        const design = canvasRef.current?.getDesign?.();
        if (design) {
          await fetch(`/api/canvas-versions/${encodeURIComponent(pageId)}`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ design, source: 'publish', label: 'Published' }),
          });
        }
      } catch (e) { /* non-fatal */ }
    }
  };

  // Cmd+K palette + ? shortcut overlay — global shortcuts at the editor
  // shell level so they also fire when no block is selected.
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      const inField = tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); setShowPalette(true); return;
      }
      if (!inField && e.key === '?') {
        e.preventDefault(); setShowShortcuts(true); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleManualSave();
      }
    };
    window.addEventListener('keydown', onKey);
    const onOpenMedia = (e) => {
      setMediaPickHandler(() => e.detail?.onPick || null);
      setMediaPickKind(e.detail?.kind || null);
      setShowMedia(true);
    };
    window.addEventListener('canvas:open-media-library', onOpenMedia);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('canvas:open-media-library', onOpenMedia);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Core axe runner used by both the manual button and the post-save
  // auto-audit. Returns the mapped issue list (or null on hard failure) and
  // never throws.
  const runAxeOnPreview = useCallback(async ({ silent = false } = {}) => {
    const iframe = previewIframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc) {
      if (!silent) toast.error('Preview is not loaded yet. Try again in a moment.');
      return null;
    }
    setAxeRunning(true);
    try {
      const axe = (await import('axe-core')).default;
      const results = await axe.run(doc, {
        runOnly: ['wcag2a', 'wcag2aa', 'best-practice'],
        resultTypes: ['violations'],
      });
      const sevFromImpact = (impact) => {
        if (impact === 'critical' || impact === 'serious') return 'error';
        if (impact === 'moderate') return 'warning';
        return 'info';
      };
      // Walk up from each failing node to the nearest [data-block-id] so
      // axe issues can be filed against specific canvas blocks (and surfaced
      // in the inspector / layers / a11y panel alongside heuristic issues).
      const blockMap = new Map();
      try {
        const design = canvasRef.current?.getDesign?.();
        const visit = (b) => {
          if (!b) return;
          if (b.id) blockMap.set(b.id, b.name || b.type || b.id);
          (b.children || []).forEach(visit);
        };
        (design?.root?.children || []).forEach(visit);
      } catch { /* best-effort */ }
      const blockIdForNode = (target) => {
        const sel = Array.isArray(target) ? target[target.length - 1] : target;
        if (!sel || typeof sel !== 'string') return null;
        let el = null;
        try { el = doc.querySelector(sel); } catch { return null; }
        while (el && el !== doc.documentElement) {
          const id = el.getAttribute && el.getAttribute('data-block-id');
          if (id) return id;
          el = el.parentElement;
        }
        return null;
      };
      const mapped = (results.violations || []).flatMap((v) =>
        v.nodes.map((n, i) => {
          const blockId = blockIdForNode(n.target);
          return {
            blockId,
            blockName: blockId ? (blockMap.get(blockId) || null) : null,
            rule: `axe:${v.id}`,
            severity: sevFromImpact(v.impact),
            message: `${v.help}${blockId ? '' : ` (${(n.target || []).join(' ') || `match #${i + 1}`})`}`,
          };
        }),
      );
      setAxeIssues(mapped);
      setAxeStale(false);
      setAxeLastRunAt(Date.now());
      lastAxeDesignRef.current = canvasRef.current?.getDesign?.() || null;
      if (!silent) {
        const summary = mapped.reduce(
          (acc, m) => ({ ...acc, [m.severity]: (acc[m.severity] || 0) + 1 }),
          {},
        );
        if (mapped.length === 0) {
          toast.success('Full audit passed — no axe-core violations found.');
        } else {
          toast.message(
            `Full audit found ${mapped.length} issue(s): ${summary.error || 0} error · ${summary.warning || 0} warning · ${summary.info || 0} info`,
            { duration: 6000 },
          );
        }
      }
      return mapped;
    } catch (err) {
      console.error('axe-core run failed', err);
      if (!silent) toast.error(`Audit failed: ${err.message || err}`);
      return null;
    } finally {
      setAxeRunning(false);
    }
  }, []);

  // Manual "Run full audit" entry point — opens the preview modal if
  // needed. axe-core needs the iframe document, so the modal must be
  // mounted before we can scan.
  const handleRunFullAudit = async () => {
    if (!page?.slug) {
      toast.error('Save a slug for this page before running a full audit.');
      return;
    }
    if (!showAuditModal) {
      setShowAuditModal(true);
      autoAuditPendingRef.current = true;
      toast.message('Preview opening — audit will run automatically once loaded.');
      return;
    }
    await runAxeOnPreview();
  };

  // Fires when the preview iframe finishes loading. If a save (or first
  // open) flagged an auto-audit, run axe now so results stay in sync.
  const handlePreviewIframeLoad = useCallback(() => {
    if (!autoAuditPendingRef.current) return;
    autoAuditPendingRef.current = false;
    // Give the SPA inside the iframe a tick to mount its tree before scanning.
    setTimeout(() => { runAxeOnPreview({ silent: true }); }, 400);
  }, [runAxeOnPreview]);

  // Opening the preview modal for the first time should also trigger an
  // audit so authors don't have to click twice.
  useEffect(() => {
    if (showAuditModal && axeIssues === null) {
      autoAuditPendingRef.current = true;
    }
  }, [showAuditModal, axeIssues]);

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
    <div className="h-screen flex flex-col bg-slate-100" data-testid="canvas-page-editor">
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
            {isDirty ? (
              <Badge className="bg-amber-100 text-amber-700" data-testid="badge-unsaved">
                Unsaved
              </Badge>
            ) : (
              <Badge className="bg-slate-100 text-slate-600" data-testid="badge-saved">
                Saved
              </Badge>
            )}
            {saveDesignMutation.isPending && (
              <span className="text-xs text-slate-500" data-testid="text-saving">Saving…</span>
            )}
          </div>
          <span className="text-xs text-slate-500 truncate">/{page.slug}</span>
        </div>

        <div className="flex-1" />

        {/* Breakpoint switcher */}
        <div className="inline-flex rounded-md border border-slate-200 bg-white" role="group" aria-label="Active breakpoint">
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
          onClick={() => setShowAuditModal((v) => !v)}
          data-testid="button-toggle-preview"
          aria-pressed={showAuditModal}
        >
          <Eye className="w-4 h-4 mr-2" />
          {showAuditModal ? 'Close preview' : 'Preview'}
        </Button>

        <Button
          variant="outline"
          size="sm"
          onClick={handleRunFullAudit}
          disabled={axeRunning}
          data-testid="button-run-full-audit"
          title="Run a full axe-core audit against the rendered preview"
        >
          {axeRunning
            ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            : <Accessibility className="w-4 h-4 mr-2" />}
          {axeRunning ? 'Auditing…' : 'Run full audit'}
          {axeIssues && axeIssues.length > 0 && (
            <Badge className="ml-2 bg-amber-100 text-amber-700" data-testid="badge-axe-count">
              {axeIssues.length}
            </Badge>
          )}
          {axeStale && (
            <Badge className="ml-2 bg-slate-200 text-slate-700" data-testid="badge-axe-stale">
              Stale
            </Badge>
          )}
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

        <Button size="sm" variant="outline" onClick={() => setShowTemplates(true)} data-testid="button-open-templates" title="Templates">
          <LayoutTemplate className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowSymbols(true)} data-testid="button-open-symbols" title="Symbols">
          <ComponentIcon className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowMedia(true)} data-testid="button-open-media" title="Media library">
          <ImagesIcon className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowVersions(true)} data-testid="button-open-versions" title="Version history">
          <HistoryIcon className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowTheme(true)} data-testid="button-open-theme" title="Tenant theme">
          <Palette className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowShortcuts(true)} data-testid="button-open-shortcuts" title="Keyboard shortcuts (?)">
          <Keyboard className="w-4 h-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowPalette(true)} data-testid="button-open-palette" title="Command palette (Cmd+K)">
          <CommandIcon className="w-4 h-4" />
        </Button>
        {page?.slug && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(`/${page.slug}`, '_blank', 'noopener')}
            data-testid="button-preview-as-visitor"
            title="Open as visitor"
          >
            <ExternalLink className="w-4 h-4 mr-2" />
            Preview as visitor
          </Button>
        )}

        <Button
          size="sm"
          onClick={handleManualSave}
          disabled={saveDesignMutation.isPending || !isDirty}
          data-testid="button-save"
        >
          <Save className="w-4 h-4 mr-2" />
          Save
        </Button>
      </header>

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <CanvasBuilder
            ref={canvasRef}
            initialDesign={initialDesign}
            breakpoint={breakpoint}
            onBreakpointChange={setBreakpoint}
            onSave={handleSave}
            isSaving={saveDesignMutation.isPending}
            isDirty={isDirty}
            onDirtyChange={handleDirtyChange}
            extraIssues={axeStale ? [] : (axeIssues || [])}
          />
        </div>

      </div>

      {/* Preview & audit modal — the iframe inside is the single host for
          `previewIframeRef`, so closing the modal also tears down the
          scannable document. Re-running the audit re-scans this iframe;
          the last result remains visible on the canvas after close. */}
      <Dialog open={showAuditModal} onOpenChange={setShowAuditModal}>
        <DialogContent
          className="max-w-[min(96vw,1480px)] w-[96vw] p-0 gap-0 sm:rounded-md flex flex-col"
          style={{ height: 'min(92vh, 960px)' }}
          data-testid="dialog-preview-audit"
        >
          <DialogHeader className="px-4 py-3 border-b border-slate-200 bg-white shrink-0">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                <DialogTitle className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Eye className="w-4 h-4 text-slate-500" />
                  Preview &amp; audit
                </DialogTitle>
                <div className="flex items-center gap-1" role="group" aria-label="Preview breakpoint">
                  {BREAKPOINTS.map((bp) => {
                    const Icon = bp.icon;
                    const active = breakpoint === bp.id;
                    return (
                      <Button
                        key={bp.id}
                        variant={active ? 'default' : 'outline'}
                        size="icon"
                        onClick={() => setBreakpoint(bp.id)}
                        aria-pressed={active}
                        aria-label={`${bp.label} preview`}
                        title={bp.label}
                        data-testid={`button-modal-breakpoint-${bp.id}`}
                      >
                        <Icon className="w-4 h-4" />
                      </Button>
                    );
                  })}
                </div>
                {isDirty && (
                  <Badge className="bg-amber-100 text-amber-700" data-testid="badge-preview-stale">
                    Save to refresh
                  </Badge>
                )}
                {axeStale && axeIssues && (
                  <Badge className="bg-slate-200 text-slate-700" data-testid="badge-modal-axe-stale">
                    Audit stale
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPreviewNonce((n) => n + 1)}
                  data-testid="button-refresh-preview"
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  onClick={() => runAxeOnPreview()}
                  disabled={axeRunning}
                  data-testid="button-modal-run-audit"
                >
                  {axeRunning
                    ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    : <Accessibility className="w-4 h-4 mr-2" />}
                  {axeRunning ? 'Auditing…' : 'Run full audit'}
                </Button>
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto flex justify-center bg-slate-200">
            {page?.slug ? (
              <iframe
                ref={previewIframeRef}
                key={previewNonce}
                title="Page preview"
                src={`/${page.slug}?_canvasPreview=${previewNonce}&_bp=${breakpoint}`}
                className="border-0 bg-white h-full"
                style={{
                  width: breakpoint === 'mobile' ? 375 :
                         breakpoint === 'tablet' ? 768 : '100%',
                  maxWidth: '100%',
                }}
                onLoad={handlePreviewIframeLoad}
                data-testid="iframe-preview"
              />
            ) : (
              <div className="p-4 text-sm text-slate-500" data-testid="text-preview-no-slug">
                Save a slug for this page before previewing.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Phase 7 dialogs */}
      <TemplatesDialog open={showTemplates} onOpenChange={setShowTemplates} canvasRef={canvasRef} />
      <SymbolsDialog open={showSymbols} onOpenChange={setShowSymbols} canvasRef={canvasRef} />
      <VersionsDialog open={showVersions} onOpenChange={setShowVersions} pageId={pageId} onRestored={() => {
        queryClient.invalidateQueries({ queryKey: ['canvas-page', pageId] });
      }} />
      <MediaLibraryDialog
        open={showMedia}
        kind={mediaPickKind}
        onOpenChange={(o) => { setShowMedia(o); if (!o) { setMediaPickHandler(null); setMediaPickKind(null); } }}
        onPick={(asset) => {
          if (mediaPickHandler) {
            // Called from a block inspector — route the asset back to it
            // so the existing block updates in place.
            mediaPickHandler(asset);
            setMediaPickHandler(null);
            setMediaPickKind(null);
            toast.success('Asset set');
            return;
          }
          // Toolbar entry point — insert a new image block.
          canvasRef.current?.addBlocks?.([{
            type: 'image',
            name: asset.name || 'Image',
            desktop: { x: 40, y: 40, w: asset.width || 320, h: asset.height || 200, hidden: false },
            content: { src: asset.url, alt: asset.alt_text || asset.name || '' },
          }]);
          toast.success('Image inserted');
        }}
      />
      <ThemeDialog open={showTheme} onOpenChange={setShowTheme} />
      <ShortcutsOverlay open={showShortcuts} onOpenChange={setShowShortcuts} />
      <CommandPalette
        open={showPalette}
        onOpenChange={setShowPalette}
        actions={[
          { id: 'save', label: 'Save page', hint: 'Cmd+S', run: handleManualSave },
          { id: 'publish', label: page?.status === 'published' ? 'Unpublish page' : 'Publish page', run: handleTogglePublish },
          { id: 'templates', label: 'Open templates…', run: () => setShowTemplates(true) },
          { id: 'symbols', label: 'Open symbols…', run: () => setShowSymbols(true) },
          { id: 'versions', label: 'Version history…', run: () => setShowVersions(true) },
          { id: 'media', label: 'Media library…', run: () => setShowMedia(true) },
          { id: 'theme', label: 'Edit tenant theme…', run: () => setShowTheme(true) },
          { id: 'shortcuts', label: 'Keyboard shortcuts', hint: '?', run: () => setShowShortcuts(true) },
          { id: 'unlink-symbol', label: 'Unlink selected symbol', run: () => unlinkSelectedSymbol(canvasRef) },
          { id: 'preview-visitor', label: 'Preview as visitor', run: () => page?.slug && window.open(`/${page.slug}`, '_blank', 'noopener') },
          { id: 'toggle-preview', label: showAuditModal ? 'Close preview' : 'Open preview & audit', run: () => setShowAuditModal((v) => !v) },
          // Live block index — every block on this page becomes a
          // jump target. Selecting one scrolls to it and opens its
          // inspector via the CanvasBuilder imperative API.
          ...(canvasRef.current?.getDesign?.()?.root?.sections?.[0]?.children || []).map((b) => ({
            id: `jump-${b.id}`,
            label: `Jump to ${b.name || b.type}`,
            hint: 'block',
            run: () => canvasRef.current?.setSelection?.(b.id),
          })),
          // Other canvas pages — jump to them in the editor without
          // leaving the keyboard. We rely on the IEditPage list already
          // hydrated for the page picker.
          ...(allPages || [])
            .filter((p) => p.id !== pageId && p.builder_type === 'canvas')
            .map((p) => ({
              id: `goto-${p.id}`,
              label: `Open page: ${p.title || p.slug}`,
              hint: 'page',
              run: () => navigate(createPageUrl(`CanvasPageEditor?pageId=${p.id}`)),
            })),
        ]}
      />
    </div>
  );
}
