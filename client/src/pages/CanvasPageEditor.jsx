import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import {
  ArrowLeft, Save, Eye,
  Monitor, Tablet, Smartphone,
  Accessibility, Loader2,
  LayoutTemplate, Component as ComponentIcon, History as HistoryIcon,
  Images as ImagesIcon, Palette, Keyboard, Command as CommandIcon, ExternalLink,
  Unlink, FileText,
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
import CanvasA11yPanel from "@/components/canvas/CanvasA11yPanel";
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
  // The persistent Audit report drawer — opens from the toolbar summary
  // badge and lists every issue with enriched element info. Independent
  // of the Preview modal so authors can review findings any time.
  const [showAuditDrawer, setShowAuditDrawer] = useState(false);
  // Publish confirmation state. Non-null while the dialog is visible.
  //   { blocking: A11yIssue[], missingAudit: bool, staleAudit: bool, newStatus }
  const [publishConfirm, setPublishConfirm] = useState(null);
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
  // When non-null, the drawer is showing a persisted past run instead of
  // the most recent in-memory result. Used to disable "stale" warnings and
  // to surface a "return to latest" affordance.
  const [viewingRunId, setViewingRunId] = useState(null);
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

  // Performs the actual publish flow (save + status update + version
  // snapshot). Split out from handleTogglePublish so the confirm dialog
  // can call it directly after the author opts to publish anyway.
  const performPublish = useCallback(async (newStatus) => {
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
  }, [pageId, updatePageMetaMutation]);

  const handleTogglePublish = async () => {
    if (!page) return;
    const newStatus = page.status === 'published' ? 'draft' : 'published';

    // Block-validation errors (required fields) keep their existing hard
    // block. Only the accessibility gate has been softened.
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

      // Accessibility findings no longer block publish — but if there are
      // must-fix issues, missing results, or stale results, surface the
      // summary in a confirm dialog so authors make an informed choice.
      const a11yIssues = auditCanvasDesign(designToCheck);
      const axeBlocking = (!axeStale && Array.isArray(axeIssues))
        ? axeIssues.filter((i) => i.severity === 'error')
        : [];
      const blocking = [...getBlockingIssues(a11yIssues), ...axeBlocking];
      const missingAudit = axeIssues === null;
      const staleAudit = !!axeIssues && axeStale;

      if (blocking.length > 0 || missingAudit || staleAudit) {
        setPublishConfirm({ blocking, missingAudit, staleAudit, newStatus });
        return;
      }
    }

    await performPublish(newStatus);
  };

  // Confirm-dialog action handlers.
  const handleConfirmPublishAnyway = useCallback(async () => {
    const target = publishConfirm?.newStatus || 'published';
    setPublishConfirm(null);
    await performPublish(target);
  }, [publishConfirm, performPublish]);

  const handleConfirmRunAudit = useCallback(async () => {
    setPublishConfirm(null);
    if (!page?.slug) {
      toast.error('Save a slug for this page before running an audit.');
      return;
    }
    if (!showAuditModal) {
      setShowAuditModal(true);
      autoAuditPendingRef.current = true;
      return;
    }
    await runAxeOnPreview();
  }, [page?.slug, showAuditModal]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // Use an explicit context-spec object so axe-core 4.10's
      // normalizeRunParams reliably identifies the first arg as context
      // (not options). Passing the raw iframe `document` trips
      // "axe.run arguments are invalid" due to cross-realm instanceof
      // checks — same issue we hit on the server-side runner.
      const ctx = { include: [doc.documentElement] };
      const results = await axe.run(ctx, {
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
          const selector = Array.isArray(n.target) ? n.target : (n.target ? [String(n.target)] : []);
          return {
            blockId,
            blockName: blockId ? (blockMap.get(blockId) || null) : null,
            rule: `axe:${v.id}`,
            severity: sevFromImpact(v.impact),
            // Keep the human help text clean — the selector & html snippet
            // are surfaced separately in the audit panels so document-level
            // issues (e.g. contrast) remain identifiable.
            message: v.help || v.description || v.id,
            selector,
            html: n.html || null,
            helpUrl: v.helpUrl || null,
            target: n.target || null,
          };
        }),
      );
      setAxeIssues(mapped);
      setAxeStale(false);
      setAxeLastRunAt(Date.now());
      setViewingRunId(null);
      lastAxeDesignRef.current = canvasRef.current?.getDesign?.() || null;
      // Persist the run so authors can revisit it later. Best-effort:
      // failures here don't block the in-editor experience.
      if (pageId) {
        try {
          const resp = await fetch(`/api/canvas-page-audits/${encodeURIComponent(pageId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ issues: mapped }),
          });
          if (resp.ok) {
            queryClient.invalidateQueries({ queryKey: ['canvas-page-audits', pageId] });
          }
        } catch { /* non-fatal */ }
      }
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
      console.error('[canvas-axe] axe.run failed', err);
      if (!silent) toast.error('Audit failed — see browser console for details.');
      return null;
    } finally {
      setAxeRunning(false);
    }
  }, [pageId, queryClient]);

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

  const handleLocateIssue = useCallback((issue) => {
    if (!issue || !issue.blockId) return;
    // The fix has to be made on the canvas editing surface, so Locate
    // selects + scrolls + pulses the block here. The preview iframe is
    // intentionally left alone.
    try { canvasRef.current?.setSelection?.(issue.blockId); } catch { /* ignore */ }
    if (typeof document === 'undefined') return;
    // The setSelection helper schedules its own scrollIntoView on a
    // microtask; wait one frame so the block is in view before we add
    // the pulse class.
    setTimeout(() => {
      // Scope to the canvas stage — `data-block-id` is also present on
      // issue rows in CanvasA11yPanel, so a document-wide query can
      // resolve to the panel row instead of the canvas block.
      const stage = document.querySelector('[data-testid="canvas-stage"]');
      const el = (stage || document).querySelector(
        `[data-testid="canvas-block-${issue.blockId}"]`,
      );
      if (!el) return;
      el.classList.remove('canvas-locate-pulse');
      // Force reflow so re-adding the class restarts the animation when
      // the same block is located twice in a row.
      // eslint-disable-next-line no-unused-expressions
      el.offsetWidth;
      el.classList.add('canvas-locate-pulse');
      setTimeout(() => {
        try { el.classList.remove('canvas-locate-pulse'); } catch { /* ignore */ }
      }, 1600);
    }, 80);
  }, []);

  // Fires when the preview iframe finishes loading. Used to kick off an
  // auto-audit once the SPA inside the iframe has mounted.
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

  // Persisted audit run history (Task #919). Lets authors see how
  // accessibility issues have evolved over time and re-open a past run.
  const { data: auditRunsData } = useQuery({
    queryKey: ['canvas-page-audits', pageId],
    queryFn: async () => {
      const resp = await fetch(`/api/canvas-page-audits/${encodeURIComponent(pageId)}`, {
        credentials: 'include',
      });
      if (!resp.ok) return { runs: [] };
      return resp.json();
    },
    enabled: !!pageId,
    staleTime: 30_000,
  });
  const auditRuns = auditRunsData?.runs || [];

  // Load a persisted past run into the drawer. The current in-memory
  // result is recoverable via the "Show latest" affordance.
  const latestInMemoryRef = useRef(null);
  const handleViewPastRun = useCallback(async (runId) => {
    if (!pageId || !runId) return;
    if (viewingRunId === null) {
      latestInMemoryRef.current = {
        issues: axeIssues,
        stale: axeStale,
        lastRunAt: axeLastRunAt,
      };
    }
    try {
      const resp = await fetch(
        `/api/canvas-page-audits/${encodeURIComponent(pageId)}?runId=${encodeURIComponent(runId)}`,
        { credentials: 'include' },
      );
      if (!resp.ok) {
        toast.error('Failed to load past audit run.');
        return;
      }
      const body = await resp.json();
      const run = body.run;
      if (!run) return;
      setAxeIssues(Array.isArray(run.issues) ? run.issues : []);
      setAxeStale(false);
      setAxeLastRunAt(new Date(run.created_at).getTime());
      setViewingRunId(runId);
    } catch {
      toast.error('Failed to load past audit run.');
    }
  }, [pageId, viewingRunId, axeIssues, axeStale, axeLastRunAt]);

  const handleReturnToLatest = useCallback(() => {
    const snap = latestInMemoryRef.current;
    if (!snap) {
      setViewingRunId(null);
      return;
    }
    setAxeIssues(snap.issues);
    setAxeStale(snap.stale);
    setAxeLastRunAt(snap.lastRunAt);
    setViewingRunId(null);
    latestInMemoryRef.current = null;
  }, []);

  // Severity breakdown for the persistent audit summary indicator. Authors
  // need to keep an eye on audit health even after closing the preview
  // modal, so we surface a count + per-severity totals (and the stale
  // flag) on the editor toolbar. Hidden until the first audit has run.
  const axeSummary = useMemo(() => {
    if (!Array.isArray(axeIssues)) return null;
    return axeIssues.reduce(
      (acc, m) => {
        acc.total += 1;
        if (m.severity === 'error') acc.error += 1;
        else if (m.severity === 'warning') acc.warning += 1;
        else acc.info += 1;
        return acc;
      },
      { total: 0, error: 0, warning: 0, info: 0 },
    );
  }, [axeIssues]);

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
        </Button>

        <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAuditDrawer(true)}
            data-testid="button-audit-summary"
            title={
              !axeSummary
                ? 'Open the audit report.'
                : axeSummary.total === 0
                ? 'Last audit passed — click to open the audit report.'
                : `Last audit: ${axeSummary.error} error · ${axeSummary.warning} warning · ${axeSummary.info} info. Click to open the audit report.`
            }
            aria-label={
              !axeSummary
                ? 'Open audit report.'
                : axeSummary.total === 0
                ? 'Last audit passed. Open audit report.'
                : `Last audit found ${axeSummary.total} issues (${axeSummary.error} error, ${axeSummary.warning} warning, ${axeSummary.info} info). Open audit report.`
            }
          >
            <FileText className="w-4 h-4 mr-2" />
            {!axeSummary ? (
              <span className="text-slate-700" data-testid="badge-axe-summary-empty">
                Audit report
              </span>
            ) : axeSummary.total === 0 ? (
              <Badge
                className="bg-emerald-100 text-emerald-700"
                data-testid="badge-axe-summary-pass"
              >
                Audit: 0 issues
              </Badge>
            ) : (
              <span className="inline-flex items-center gap-1" data-testid="badge-axe-summary">
                <span className="text-slate-700">
                  Audit: {axeSummary.total} issue{axeSummary.total === 1 ? '' : 's'}
                </span>
                {axeSummary.error > 0 && (
                  <Badge
                    className="bg-rose-100 text-rose-700"
                    data-testid="badge-axe-summary-error"
                  >
                    {axeSummary.error} error
                  </Badge>
                )}
                {axeSummary.warning > 0 && (
                  <Badge
                    className="bg-amber-100 text-amber-700"
                    data-testid="badge-axe-summary-warning"
                  >
                    {axeSummary.warning} warning
                  </Badge>
                )}
                {axeSummary.info > 0 && (
                  <Badge
                    className="bg-sky-100 text-sky-700"
                    data-testid="badge-axe-summary-info"
                  >
                    {axeSummary.info} info
                  </Badge>
                )}
              </span>
            )}
            {axeStale && !viewingRunId && (
              <Badge
                className="ml-2 bg-slate-200 text-slate-700"
                data-testid="badge-axe-summary-stale"
              >
                Stale
              </Badge>
            )}
            {viewingRunId && (
              <Badge
                className="ml-2 bg-sky-100 text-sky-700"
                data-testid="badge-axe-summary-viewing-past"
              >
                Past run
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
            onLocateInPreview={handleLocateIssue}
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

      {/* Publish confirmation — a11y findings no longer block publish but
          we surface them in a confirm dialog so authors make an informed
          choice. Block-validation errors still hard-block earlier. */}
      <Dialog
        open={!!publishConfirm}
        onOpenChange={(o) => { if (!o) setPublishConfirm(null); }}
      >
        <DialogContent className="max-w-lg" data-testid="dialog-publish-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Accessibility className="w-4 h-4 text-amber-600" />
              Publish with accessibility findings?
            </DialogTitle>
            <DialogDescription>
              {publishConfirm?.missingAudit
                ? 'No full accessibility audit has been run on this page yet. You can publish anyway, but the audit can surface contrast and other issues that the live design check misses.'
                : publishConfirm?.staleAudit
                  ? 'The page has changed since the last accessibility audit, so the results may be out of date. You can publish anyway or re-run the audit first.'
                  : `This page has ${publishConfirm?.blocking?.length || 0} must-fix accessibility issue${publishConfirm?.blocking?.length === 1 ? '' : 's'}. You can publish anyway and fix them over time, or cancel to address them now.`}
            </DialogDescription>
          </DialogHeader>
          {publishConfirm?.blocking?.length > 0 && (() => {
            const counts = publishConfirm.blocking.reduce((acc, i) => {
              acc[i.severity] = (acc[i.severity] || 0) + 1;
              return acc;
            }, {});
            return (
              <div data-testid="publish-confirm-summary">
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {counts.error > 0 && (
                    <Badge className="bg-rose-100 text-rose-700" data-testid="publish-confirm-count-error">
                      {counts.error} error{counts.error === 1 ? '' : 's'}
                    </Badge>
                  )}
                  {counts.warning > 0 && (
                    <Badge className="bg-amber-100 text-amber-700" data-testid="publish-confirm-count-warning">
                      {counts.warning} warning{counts.warning === 1 ? '' : 's'}
                    </Badge>
                  )}
                </div>
                <ul className="text-xs text-slate-700 space-y-1 max-h-40 overflow-auto">
                  {publishConfirm.blocking.slice(0, 6).map((i, idx) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span className="text-slate-400 mt-0.5">•</span>
                      <span>
                        {i.blockName ? <span className="font-medium">{i.blockName}: </span> : null}
                        {i.message}
                      </span>
                    </li>
                  ))}
                  {publishConfirm.blocking.length > 6 && (
                    <li className="text-slate-500">
                      …and {publishConfirm.blocking.length - 6} more
                    </li>
                  )}
                </ul>
                <button
                  type="button"
                  className="mt-2 text-xs text-primary hover:underline inline-flex items-center gap-1"
                  onClick={() => { setPublishConfirm(null); setShowAuditDrawer(true); }}
                  data-testid="button-publish-confirm-view-report"
                >
                  <FileText className="w-3 h-3" /> Open audit report
                </button>
              </div>
            );
          })()}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setPublishConfirm(null)}
              data-testid="button-publish-confirm-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={handleConfirmRunAudit}
              disabled={axeRunning}
              data-testid="button-publish-confirm-run-audit"
            >
              {axeRunning
                ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                : <Accessibility className="w-4 h-4 mr-2" />}
              Run audit now
            </Button>
            <Button
              onClick={handleConfirmPublishAnyway}
              data-testid="button-publish-confirm-publish"
            >
              Publish anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Persistent Audit report drawer. Independent of the Preview modal
          so the report stays viewable any time once an audit has run. */}
      <Sheet open={showAuditDrawer} onOpenChange={setShowAuditDrawer}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md overflow-y-auto p-0 flex flex-col"
          data-testid="sheet-audit-report"
        >
          <SheetHeader className="px-4 py-3 border-b border-slate-200 shrink-0">
            <SheetTitle className="text-base font-semibold flex items-center gap-2">
              <FileText className="w-4 h-4 text-slate-500" /> Audit report
            </SheetTitle>
            <SheetDescription className="text-xs">
              Every accessibility finding — heuristic checks plus the latest full audit. Click an issue to jump to the block, locate it in the preview, or open the WCAG reference.
            </SheetDescription>
            <div className="flex items-center gap-2 pt-2 flex-wrap">
              <Button
                size="sm"
                onClick={handleRunFullAudit}
                disabled={axeRunning}
                data-testid="button-drawer-run-audit"
              >
                {axeRunning
                  ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  : <Accessibility className="w-4 h-4 mr-2" />}
                {axeRunning ? 'Auditing…' : 'Run full audit'}
              </Button>
              {viewingRunId && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleReturnToLatest}
                  data-testid="button-drawer-return-to-latest"
                >
                  Show latest
                </Button>
              )}
              {viewingRunId ? (
                <Badge
                  className="bg-sky-100 text-sky-700"
                  data-testid="badge-drawer-viewing-past"
                >
                  Viewing past run
                </Badge>
              ) : axeStale && axeIssues && (
                <Badge
                  className="bg-slate-200 text-slate-700"
                  data-testid="badge-drawer-axe-stale"
                >
                  Stale — re-run after edits
                </Badge>
              )}
              {axeLastRunAt && (
                <span className="text-[11px] text-slate-500">
                  {viewingRunId ? 'Run' : 'Last run'} {new Date(axeLastRunAt).toLocaleString()}
                </span>
              )}
            </div>
            {auditRuns.length > 0 && (
              <div className="pt-3" data-testid="audit-history-strip">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                  History
                </div>
                <div className="flex gap-1.5 overflow-x-auto pb-1">
                  {auditRuns.map((run) => {
                    const active = viewingRunId === run.id;
                    const passed = (run.total_count || 0) === 0;
                    return (
                      <button
                        key={run.id}
                        type="button"
                        onClick={() => handleViewPastRun(run.id)}
                        className={`shrink-0 rounded-md border px-2 py-1.5 text-left text-[11px] hover-elevate ${
                          active
                            ? 'border-sky-300 bg-sky-50'
                            : 'border-slate-200 bg-white'
                        }`}
                        title={`Run by ${run.run_by_name || 'unknown'} on ${new Date(run.created_at).toLocaleString()}`}
                        data-testid={`button-audit-history-${run.id}`}
                      >
                        <div className="font-medium text-slate-700">
                          {new Date(run.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          {' '}
                          {new Date(run.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          {passed ? (
                            <Badge className="bg-emerald-100 text-emerald-700">0</Badge>
                          ) : (
                            <>
                              {run.error_count > 0 && (
                                <Badge className="bg-rose-100 text-rose-700">{run.error_count}</Badge>
                              )}
                              {run.warning_count > 0 && (
                                <Badge className="bg-amber-100 text-amber-700">{run.warning_count}</Badge>
                              )}
                              {run.info_count > 0 && (
                                <Badge className="bg-sky-100 text-sky-700">{run.info_count}</Badge>
                              )}
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </SheetHeader>
          <div className="p-4 flex-1 overflow-y-auto space-y-3">
            {axeIssues === null && (
              <div
                className="text-xs text-slate-600 rounded border border-slate-200 bg-slate-50 px-2 py-2"
                data-testid="audit-drawer-empty"
              >
                Full audit not run yet — heuristic findings are shown below. Click <span className="font-medium">Run full audit</span> above to also scan the rendered preview with axe-core.
              </div>
            )}
            <CanvasA11yPanel
              issues={(axeIssues || [])
                .concat(auditCanvasDesign(canvasRef.current?.getDesign?.() || page?.canvas_design || {}))}
              selectedIds={[]}
              onJumpToBlock={(id) => {
                try { canvasRef.current?.setSelection?.(id); } catch { /* ignore */ }
                setShowAuditDrawer(false);
              }}
              onLocate={(issue) => {
                if (!issue?.blockId) return;
                setShowAuditDrawer(false);
                handleLocateIssue(issue);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>

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
