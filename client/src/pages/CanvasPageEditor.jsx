import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  Unlink, FileText, Pencil,
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
  // Dual-view accessibility audit (Task #925). For hybrid pages the editor
  // user (logged in) sees the member chrome, but anonymous visitors see a
  // different layout. We audit both. `previewView` controls which version
  // the iframe is currently loading: 'member' (default — cookies attached,
  // portal chrome) or 'public' (DynamicPage forces public layout via the
  // `_publicView=1` query param). Non-hybrid pages stay on a single view.
  const [previewView, setPreviewView] = useState('member');
  // Track which axe view tab the drawer is currently showing on dual-view
  // pages. Defaults to the first applicable view.
  const [auditViewTab, setAuditViewTab] = useState('member');
  // Phase 7 dialog visibility flags. The command palette and shortcut
  // overlay are toggled via global keyboard shortcuts (Cmd+K and ?).
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSymbols, setShowSymbols] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showMedia, setShowMedia] = useState(false);
  const [showTheme, setShowTheme] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  // Rename / change-slug dialog state (Task #979).
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameSlug, setRenameSlug] = useState('');
  const [renameLayoutType, setRenameLayoutType] = useState('public');
  const [renameError, setRenameError] = useState('');
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
  // Last `canvas-preview-ready` signal received from the preview iframe.
  // Replaces the old fixed-`setTimeout(400)` wait after `iframe.onload`,
  // which scanned a partially-mounted SPA. Holds the matching nonce +
  // publicView flag so a stale message from a prior load can't resolve a
  // new wait.
  const previewReadyRef = useRef(null);
  // Active waiters for the next ready signal, notified by the global
  // postMessage listener installed below.
  const readyWaitersRef = useRef(new Set());

  // Listen for ready signals from the preview iframe and store / fan
  // them out to any in-flight `waitForPreviewReady` callers.
  useEffect(() => {
    const onMessage = (e) => {
      const iframe = previewIframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      const data = e.data;
      if (!data || data.type !== 'canvas-preview-ready') return;
      const sig = {
        nonce: data.nonce,
        publicView: !!data.publicView,
        at: Date.now(),
      };
      previewReadyRef.current = sig;
      // Snapshot first — waiters may remove themselves during iteration.
      Array.from(readyWaitersRef.current).forEach((fn) => {
        try { fn(sig); } catch { /* ignore */ }
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Invalidate the last-known ready signal whenever the iframe is about
  // to (re)load with a new src — either because Refresh bumped the
  // nonce, or the dual-pass audit flipped between member/public views.
  useEffect(() => {
    previewReadyRef.current = null;
  }, [previewNonce, previewView]);

  // Wait until the preview iframe posts a `canvas-preview-ready` signal
  // that matches the supplied nonce + publicView (or fall back to a
  // resolved result after `timeoutMs`). Resolves with
  // `{ ready: true }` when the handshake completes, `{ ready: false,
  // timedOut: true }` if the fallback fires. Never rejects.
  const waitForPreviewReady = useCallback((opts = {}) => {
    const { nonce, publicView, timeoutMs = 8000 } = opts;
    const matches = (sig) => {
      if (!sig) return false;
      if (nonce != null && sig.nonce !== nonce) return false;
      if (publicView != null && sig.publicView !== !!publicView) return false;
      return true;
    };
    return new Promise((resolve) => {
      if (matches(previewReadyRef.current)) { resolve({ ready: true }); return; }
      let done = false;
      const onSig = (sig) => {
        if (done || !matches(sig)) return;
        done = true;
        readyWaitersRef.current.delete(onSig);
        clearTimeout(timer);
        resolve({ ready: true });
      };
      readyWaitersRef.current.add(onSig);
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        readyWaitersRef.current.delete(onSig);
        // eslint-disable-next-line no-console
        console.warn('[canvas-axe] preview-ready handshake timed out; scanning anyway');
        resolve({ ready: false, timedOut: true });
      }, timeoutMs);
    });
  }, []);

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

  // Which views apply to this page, in audit order. Hybrid pages render
  // differently for anonymous visitors vs. logged-in members, so we run a
  // dual-pass audit and surface both results. Public/member-only pages
  // only ever render one way, so we audit once. Member is audited first
  // when applicable because that's the iframe's natural starting state.
  // Declared after the `page` useQuery so its dependency array can read
  // `page?.layout_type` without tripping a temporal-dead-zone error.
  const viewsToAudit = useMemo(() => {
    const lt = page?.layout_type || 'public';
    if (lt === 'hybrid') return ['member', 'public'];
    if (lt === 'public') return ['public'];
    return ['member'];
  }, [page?.layout_type]);
  // Keep the iframe initial view + drawer tab in sync with the page's
  // layout type. For single-view pages the value never matters but we
  // still set it so the iframe and tab labels match the only view.
  useEffect(() => {
    setPreviewView(viewsToAudit[0]);
  }, [viewsToAudit]);

  // Task #1448: cross-page anchor links. Resolve every OTHER canvas page so
  // the inspector's link fields can target a section on a different page.
  // `allPages` already carries `canvas_design` (the entity list selects all
  // columns), so no extra round trip is needed. We drop the page being
  // edited, non-canvas pages, and pages without a slug (nothing to link to).
  const otherPages = useMemo(() => {
    if (!Array.isArray(allPages)) return [];
    return allPages
      .filter((p) => p.builder_type === 'canvas' && p.slug && p.id !== (page?.id || pageId))
      .map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title || p.slug,
        design: p.canvas_design,
      }));
  }, [allPages, page?.id, pageId]);

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

  const openRenameDialog = useCallback(() => {
    if (!page) return;
    setRenameTitle(page.title || '');
    setRenameSlug(page.slug || '');
    setRenameLayoutType(page.layout_type || 'public');
    setRenameError('');
    setShowRenameDialog(true);
  }, [page]);

  const failRename = useCallback((msg) => {
    setRenameError(msg);
    toast.error(msg);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!page) return;
    const title = (renameTitle || '').trim();
    const slug = (renameSlug || '').trim().toLowerCase();
    if (!title) { failRename('Title is required'); return; }
    if (!slug) { failRename('Slug is required'); return; }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      failRename('Slug must be lowercase letters, numbers, and hyphens only');
      return;
    }
    const others = Array.isArray(allPages) ? allPages.filter((p) => p.id !== page.id) : [];
    if (others.some((p) => (p.slug || '').toLowerCase() === slug)) {
      failRename('Another page already uses this slug');
      return;
    }
    const layoutType = ['public', 'member', 'hybrid'].includes(renameLayoutType) ? renameLayoutType : 'public';
    setRenameError('');
    try {
      await updatePageMetaMutation.mutateAsync({
        id: page.id,
        data: { title, slug, layout_type: layoutType },
      });
      setShowRenameDialog(false);
    } catch (error) {
      // Surface the server error inline in the dialog too — the mutation's
      // onError already showed a toast.
      setRenameError(error?.message || 'Failed to update page');
    }
  }, [page, renameTitle, renameSlug, renameLayoutType, allPages, updatePageMetaMutation, failRename]);

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

  // Switch the preview iframe to a target view and resolve when the new
  // document has loaded. Used by the dual-pass audit runner to flip
  // between the member and public renderings of a hybrid page. The iframe
  // element itself persists across view changes (its `key` is tied to
  // `previewNonce`, not the view) so we can attach a one-shot load
  // listener before React commits the new src.
  const reloadIframeForView = useCallback(async (view) => {
    const iframe = previewIframeRef.current;
    if (!iframe) throw new Error('iframe missing');
    // Clear any prior ready signal so a stale ready from the current
    // view can't satisfy the wait for the new view.
    previewReadyRef.current = null;
    setPreviewView(view);
    const result = await waitForPreviewReady({
      nonce: previewNonce,
      publicView: view === 'public',
      timeoutMs: 8000,
    });
    if (result.timedOut) {
      toast.message('Preview took longer than expected to finish rendering — the audit may not reflect the final page.');
    }
    return result;
  }, [previewNonce, waitForPreviewReady]);

  // Scan whatever is currently in the preview iframe with axe-core and
  // return mapped issues, tagged with the supplied `view` label. Helper
  // used by both single- and dual-pass runs.
  const scanIframeWithAxe = useCallback(async (view) => {
    const iframe = previewIframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc) throw new Error('Preview is not loaded');
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
    return (results.violations || []).flatMap((v) =>
      v.nodes.map((n) => {
        const blockId = blockIdForNode(n.target);
        const selector = Array.isArray(n.target) ? n.target : (n.target ? [String(n.target)] : []);
        return {
          blockId,
          blockName: blockId ? (blockMap.get(blockId) || null) : null,
          rule: `axe:${v.id}`,
          severity: sevFromImpact(v.impact),
          message: v.help || v.description || v.id,
          selector,
          html: n.html || null,
          helpUrl: v.helpUrl || null,
          target: n.target || null,
          view,
        };
      }),
    );
  }, []);

  // Core audit runner. Sequentially audits each applicable view (member +
  // public for hybrid pages, otherwise just one view) and concatenates
  // the tagged results into a single flat list. Per-view errors don't
  // abort the other view's pass — they just leave that view's findings
  // empty and surface a partial-failure toast.
  const runAxeOnPreview = useCallback(async ({ silent = false } = {}) => {
    const iframe = previewIframeRef.current;
    if (!iframe) {
      if (!silent) toast.error('Preview is not loaded yet. Try again in a moment.');
      return null;
    }
    setAxeRunning(true);
    const initialView = viewsToAudit[0];
    const errorViews = [];
    const allIssues = [];
    try {
      // Guard: if the iframe somehow drifted off the expected first-pass
      // view (e.g. a prior dual-pass aborted mid-restore), reload it so
      // pass-1 findings are correctly attributable to `initialView`.
      if (previewView !== initialView) {
        try { await reloadIframeForView(initialView); } catch { /* fall through; pass 1 may still run */ }
      } else {
        // Same view — but the SPA inside the iframe may still be mid-
        // render (e.g. user just clicked Refresh, or this is the first
        // auto-audit). Wait for the preview-ready handshake before we
        // scan so axe-core sees the fully-rendered page.
        const r = await waitForPreviewReady({
          nonce: previewNonce,
          publicView: initialView === 'public',
          timeoutMs: 8000,
        });
        if (r.timedOut) {
          toast.message('Preview took longer than expected to finish rendering — the audit may not reflect the final page.');
        }
      }
      // Pass 1: scan the iframe in its current state (which now matches
      // initialView).
      try {
        const r = await scanIframeWithAxe(initialView);
        allIssues.push(...r);
      } catch (e) {
        console.error('[canvas-axe] pass failed for', initialView, e);
        errorViews.push(initialView);
      }

      // Pass 2 (dual-view only): flip the iframe to the other view, scan,
      // then restore the iframe to the initial view so the editor's
      // preview surface keeps showing what the author was looking at.
      if (viewsToAudit.length > 1) {
        const otherView = viewsToAudit[1];
        try {
          await reloadIframeForView(otherView);
          const r = await scanIframeWithAxe(otherView);
          allIssues.push(...r);
        } catch (e) {
          console.error('[canvas-axe] pass failed for', otherView, e);
          errorViews.push(otherView);
        }
        try { await reloadIframeForView(initialView); } catch { /* ignore */ }
      }

      setAxeIssues(allIssues);
      setAxeStale(false);
      setAxeLastRunAt(Date.now());
      setViewingRunId(null);
      lastAxeDesignRef.current = canvasRef.current?.getDesign?.() || null;

      if (pageId) {
        try {
          const resp = await fetch(`/api/canvas-page-audits/${encodeURIComponent(pageId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              issues: allIssues,
              viewsAudited: viewsToAudit,
              failedViews: errorViews,
            }),
          });
          if (resp.ok) {
            queryClient.invalidateQueries({ queryKey: ['canvas-page-audits', pageId] });
          }
        } catch { /* non-fatal */ }
      }

      if (!silent) {
        if (errorViews.length > 0 && errorViews.length === viewsToAudit.length) {
          toast.error('Audit failed — see browser console for details.');
        } else if (errorViews.length > 0) {
          toast.warning(`Audit completed for ${viewsToAudit.length - errorViews.length} of ${viewsToAudit.length} view(s). The ${errorViews.join(' / ')} view failed.`);
        } else {
          const summary = allIssues.reduce(
            (acc, m) => ({ ...acc, [m.severity]: (acc[m.severity] || 0) + 1 }),
            {},
          );
          const viewSuffix = viewsToAudit.length > 1 ? ` across ${viewsToAudit.length} views` : '';
          if (allIssues.length === 0) {
            toast.success(`Full audit passed${viewSuffix} — no axe-core violations found.`);
          } else {
            toast.message(
              `Full audit${viewSuffix} found ${allIssues.length} issue(s): ${summary.error || 0} error · ${summary.warning || 0} warning · ${summary.info || 0} info`,
              { duration: 6000 },
            );
          }
        }
      }
      return allIssues;
    } catch (err) {
      console.error('[canvas-axe] axe.run failed', err);
      if (!silent) toast.error('Audit failed — see browser console for details.');
      return null;
    } finally {
      setAxeRunning(false);
    }
  }, [pageId, queryClient, viewsToAudit, previewView, previewNonce, scanIframeWithAxe, reloadIframeForView, waitForPreviewReady]);

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
  // auto-audit once the SPA inside the iframe has fully mounted. The
  // actual wait happens inside `runAxeOnPreview` via
  // `waitForPreviewReady` — this handler only flips the spinner state on
  // and triggers the runner, so the user sees "Auditing…" continuously
  // from the moment the iframe begins loading until the scan completes.
  const handlePreviewIframeLoad = useCallback(() => {
    if (!autoAuditPendingRef.current) return;
    autoAuditPendingRef.current = false;
    setAxeRunning(true);
    runAxeOnPreview({ silent: true });
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

  // Which views the drawer should render in detail. When viewing a past
  // run we trust the run's persisted `view_counts` keys so the dual /
  // single split reflects the run that was actually executed, not the
  // page's current layout (the page may have flipped between hybrid
  // and public since the run was recorded). Falls back to viewsToAudit
  // for in-memory runs or legacy rows without view_counts.
  const effectiveViews = useMemo(() => {
    if (viewingRunId) {
      const run = auditRuns.find((r) => r.id === viewingRunId);
      const vc = run?.view_counts;
      const fv = Array.isArray(run?.failed_views) ? run.failed_views : [];
      const keys = vc && typeof vc === 'object' ? Object.keys(vc) : [];
      // Union of successfully-audited views and failed views so a
      // partial-failure dual run still surfaces both tabs (the failed
      // one rendered with a "Failed" badge instead of counts).
      const union = [...keys];
      for (const v of fv) if (!union.includes(v)) union.push(v);
      if (union.length > 0) return union;
    }
    return viewsToAudit;
  }, [viewingRunId, auditRuns, viewsToAudit]);
  const isDualView = effectiveViews.length > 1;

  // Keep the audit drawer tab in sync with whichever set of views is
  // currently effective (page-derived for live runs, run-derived for
  // past runs). Without this, switching to a past run on a single-view
  // page leaves the tab pointing at a view the run never covered.
  useEffect(() => {
    setAuditViewTab((prev) => (effectiveViews.includes(prev) ? prev : effectiveViews[0]));
  }, [effectiveViews]);

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
            <Button
              size="icon"
              variant="ghost"
              onClick={openRenameDialog}
              title="Rename page / change slug"
              data-testid="button-rename-page"
            >
              <Pencil className="w-4 h-4" />
            </Button>
            <Badge variant="outline" data-testid="badge-builder-type">Canvas</Badge>
            <Badge
              className={page.status === 'published' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-700'}
              data-testid="badge-page-status"
            >
              {page.status}
            </Badge>
            {isDirty ? (
              <Badge className="bg-warning/10 text-warning" data-testid="badge-unsaved">
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
                    className="bg-warning/10 text-warning"
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
            onLocateIssue={handleLocateIssue}
            otherPages={otherPages}
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
                  <Badge className="bg-warning/10 text-warning" data-testid="badge-preview-stale">
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
                src={`/${page.slug}?_canvasPreview=${previewNonce}&_bp=${breakpoint}${previewView === 'public' ? '&_publicView=1' : ''}`}
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
              <Accessibility className="w-4 h-4 text-warning" />
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
                    <Badge className="bg-warning/10 text-warning" data-testid="publish-confirm-count-warning">
                      {counts.warning} warning{counts.warning === 1 ? '' : 's'}
                    </Badge>
                  )}
                </div>
                <ul className="text-xs text-slate-700 space-y-1 max-h-40 overflow-auto">
                  {publishConfirm.blocking.slice(0, 6).map((i, idx) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span className="text-slate-400 mt-0.5">•</span>
                      <span>
                        {i.view && isDualView ? (
                          <Badge
                            className={`mr-1 ${i.view === 'public' ? 'bg-sky-100 text-sky-700' : 'bg-violet-100 text-violet-700'}`}
                            data-testid={`publish-confirm-view-${i.view}-${idx}`}
                          >
                            {i.view === 'public' ? 'Public' : 'Member'}
                          </Badge>
                        ) : null}
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
              Every accessibility finding — heuristic checks plus the latest full audit. Click an issue to jump to the block, locate it on the canvas, or open the WCAG reference.
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
                    // Per-view severity totals (Task #926). Only present
                    // for dual-view runs; single-view runs fall back to
                    // the aggregate badges below.
                    const vc = run.view_counts && typeof run.view_counts === 'object'
                      ? run.view_counts
                      : null;
                    const failedRunViews = Array.isArray(run.failed_views)
                      ? run.failed_views
                      : [];
                    const vcKeys = vc ? Object.keys(vc) : [];
                    // Union so partial-failure dual runs still render
                    // per-view rows (failed view rendered with a
                    // "Failed" pill).
                    const viewKeys = [...vcKeys];
                    for (const fv of failedRunViews) {
                      if (!viewKeys.includes(fv)) viewKeys.push(fv);
                    }
                    const isDualRun = viewKeys.length > 1;
                    const renderViewRow = (v) => {
                      const failed = failedRunViews.includes(v);
                      const c = (vc && vc[v]) || { error: 0, warning: 0, info: 0, total: 0 };
                      const label = v === 'public' ? 'Public' : v === 'member' ? 'Member' : v;
                      return (
                        <div
                          key={v}
                          className="flex items-center gap-1"
                          data-testid={`audit-history-view-${run.id}-${v}`}
                        >
                          <span
                            className={`text-[10px] px-1 rounded ${
                              v === 'public'
                                ? 'bg-sky-100 text-sky-700'
                                : 'bg-violet-100 text-violet-700'
                            }`}
                          >
                            {label}
                          </span>
                          {failed ? (
                            <Badge
                              className="bg-slate-200 text-slate-700"
                              data-testid={`badge-audit-history-${run.id}-${v}-failed`}
                            >
                              Failed
                            </Badge>
                          ) : c.total === 0 ? (
                            <Badge className="bg-emerald-100 text-emerald-700">0</Badge>
                          ) : (
                            <>
                              {c.error > 0 && (
                                <Badge className="bg-rose-100 text-rose-700">{c.error}</Badge>
                              )}
                              {c.warning > 0 && (
                                <Badge className="bg-warning/10 text-warning">{c.warning}</Badge>
                              )}
                              {c.info > 0 && (
                                <Badge className="bg-sky-100 text-sky-700">{c.info}</Badge>
                              )}
                            </>
                          )}
                        </div>
                      );
                    };
                    const titleSuffix = isDualRun
                      ? '\n' + viewKeys.map((v) => {
                          const lbl = v === 'public' ? 'Public' : v === 'member' ? 'Member' : v;
                          if (failedRunViews.includes(v)) return `${lbl}: scan failed`;
                          const c = (vc && vc[v]) || { error: 0, warning: 0, info: 0 };
                          return `${lbl}: ${c.error} error · ${c.warning} warning · ${c.info} info`;
                        }).join('\n')
                      : '';
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
                        title={`Run by ${run.run_by_name || 'unknown'} on ${new Date(run.created_at).toLocaleString()}${titleSuffix}`}
                        data-testid={`button-audit-history-${run.id}`}
                      >
                        <div className="font-medium text-slate-700">
                          {new Date(run.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          {' '}
                          {new Date(run.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        </div>
                        {isDualRun ? (
                          <div
                            className="flex flex-col gap-0.5 mt-0.5"
                            data-testid={`audit-history-dual-${run.id}`}
                          >
                            {viewKeys.map(renderViewRow)}
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 mt-0.5">
                            {passed ? (
                              <Badge className="bg-emerald-100 text-emerald-700">0</Badge>
                            ) : (
                              <>
                                {run.error_count > 0 && (
                                  <Badge className="bg-rose-100 text-rose-700">{run.error_count}</Badge>
                                )}
                                {run.warning_count > 0 && (
                                  <Badge className="bg-warning/10 text-warning">{run.warning_count}</Badge>
                                )}
                                {run.info_count > 0 && (
                                  <Badge className="bg-sky-100 text-sky-700">{run.info_count}</Badge>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </SheetHeader>
          <div className="p-4 flex-1 overflow-y-auto space-y-4">
            {axeIssues === null && (
              <div
                className="text-xs text-slate-600 rounded border border-slate-200 bg-slate-50 px-2 py-2"
                data-testid="audit-drawer-empty"
              >
                Full audit not run yet — heuristic findings are shown below. Click <span className="font-medium">Run full audit</span> above to also scan the rendered preview with axe-core.
              </div>
            )}
            {(() => {
              const heuristicIssues = auditCanvasDesign(
                canvasRef.current?.getDesign?.() || page?.canvas_design || {},
              );
              const axeAll = axeIssues || [];
              // Backward compat: older persisted runs don't tag issues
              // with `view`; bucket them into the first effective view.
              const fallbackView = effectiveViews[0];
              const issuesForView = (v) => axeAll.filter((i) => (i.view || fallbackView) === v);
              // The metadata of the run currently displayed in the
              // drawer. For past runs this is the persisted row (so we
              // can tell which views were actually scanned and which
              // failed); for in-memory runs we synthesize the same
              // shape from the live state.
              const activeRun = viewingRunId
                ? auditRuns.find((r) => r.id === viewingRunId)
                : null;
              const runViewCounts = activeRun?.view_counts && typeof activeRun.view_counts === 'object'
                ? activeRun.view_counts
                : null;
              const runFailedViews = Array.isArray(activeRun?.failed_views)
                ? activeRun.failed_views
                : [];
              const countsFor = (v) => {
                if (runViewCounts && runViewCounts[v]) return runViewCounts[v];
                return issuesForView(v).reduce(
                  (acc, i) => {
                    acc.total += 1;
                    acc[i.severity] = (acc[i.severity] || 0) + 1;
                    return acc;
                  },
                  { total: 0, error: 0, warning: 0, info: 0 },
                );
              };
              const onJump = (id) => {
                try { canvasRef.current?.setSelection?.(id); } catch { /* ignore */ }
                setShowAuditDrawer(false);
              };
              const onLocate = (issue) => {
                if (!issue?.blockId) return;
                setShowAuditDrawer(false);
                handleLocateIssue(issue);
              };
              return (
                <>
                  <section
                    className="space-y-2"
                    data-testid="audit-section-heuristic"
                    aria-label="Heuristic design findings"
                  >
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">
                      Design checks
                    </div>
                    <CanvasA11yPanel
                      issues={heuristicIssues}
                      selectedIds={[]}
                      onJumpToBlock={onJump}
                      onLocate={onLocate}
                    />
                  </section>
                  {isDualView ? (
                    <section
                      className="space-y-2"
                      data-testid="audit-section-axe-dual"
                      aria-label="Rendered audit findings by view"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-[11px] uppercase tracking-wide text-slate-500">
                          Rendered audit (axe-core)
                        </div>
                        <div
                          className="inline-flex rounded-md border border-slate-200 bg-white"
                          role="group"
                          aria-label="Audit view"
                        >
                          {effectiveViews.map((v) => {
                            const active = auditViewTab === v;
                            const counts = countsFor(v);
                            const failed = runFailedViews.includes(v);
                            const label = v === 'public' ? 'Public view' : v === 'member' ? 'Member view' : v;
                            return (
                              <Button
                                key={v}
                                variant="ghost"
                                size="sm"
                                className={`rounded-none toggle-elevate ${active ? 'toggle-elevated' : ''}`}
                                onClick={() => setAuditViewTab(v)}
                                aria-pressed={active}
                                data-testid={`button-audit-view-${v}`}
                              >
                                <span className="mr-1.5">{label}</span>
                                {failed ? (
                                  <Badge
                                    className="bg-slate-200 text-slate-700"
                                    data-testid={`badge-audit-view-${v}-failed`}
                                  >
                                    Failed
                                  </Badge>
                                ) : counts.total === 0 && axeIssues !== null ? (
                                  <Badge className="bg-emerald-100 text-emerald-700">0</Badge>
                                ) : (
                                  <span className="inline-flex items-center gap-1">
                                    {counts.error > 0 && (
                                      <Badge
                                        className="bg-rose-100 text-rose-700"
                                        data-testid={`badge-audit-view-${v}-error`}
                                      >
                                        {counts.error}
                                      </Badge>
                                    )}
                                    {counts.warning > 0 && (
                                      <Badge
                                        className="bg-warning/10 text-warning"
                                        data-testid={`badge-audit-view-${v}-warning`}
                                      >
                                        {counts.warning}
                                      </Badge>
                                    )}
                                    {counts.info > 0 && (
                                      <Badge
                                        className="bg-sky-100 text-sky-700"
                                        data-testid={`badge-audit-view-${v}-info`}
                                      >
                                        {counts.info}
                                      </Badge>
                                    )}
                                  </span>
                                )}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                      <div data-testid={`audit-view-pane-${auditViewTab}`}>
                        <CanvasA11yPanel
                          issues={issuesForView(auditViewTab)}
                          selectedIds={[]}
                          onJumpToBlock={onJump}
                          onLocate={onLocate}
                        />
                      </div>
                    </section>
                  ) : (
                    <section
                      className="space-y-2"
                      data-testid="audit-section-axe-single"
                      aria-label="Rendered audit findings"
                    >
                      <div className="text-[11px] uppercase tracking-wide text-slate-500">
                        Rendered audit (axe-core) — {effectiveViews[0] === 'public' ? 'Public view' : 'Member view'}
                      </div>
                      <CanvasA11yPanel
                        issues={issuesForView(effectiveViews[0])}
                        selectedIds={[]}
                        onJumpToBlock={onJump}
                        onLocate={onLocate}
                      />
                    </section>
                  )}
                </>
              );
            })()}
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

      <Dialog open={showRenameDialog} onOpenChange={(open) => {
        if (!open) setRenameError('');
        setShowRenameDialog(open);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit page settings</DialogTitle>
            <DialogDescription>
              Update the page title, URL slug, and view type. Saving will reload the preview.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="rename-title">Page Title *</Label>
              <Input
                id="rename-title"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                data-testid="input-rename-title"
              />
            </div>
            <div>
              <Label htmlFor="rename-slug">URL Slug *</Label>
              <Input
                id="rename-slug"
                value={renameSlug}
                onChange={(e) => setRenameSlug(e.target.value.toLowerCase())}
                data-testid="input-rename-slug"
              />
              <p className="text-xs text-slate-500 mt-1">
                Lowercase letters, numbers, and hyphens only
              </p>
            </div>
            <div>
              <Label htmlFor="rename-layout-type">View Type</Label>
              <Select value={renameLayoutType} onValueChange={setRenameLayoutType}>
                <SelectTrigger id="rename-layout-type" data-testid="select-rename-layout-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public (Anyone can view, public layout)</SelectItem>
                  <SelectItem value="member">Portal (Members only, with sidebar)</SelectItem>
                  <SelectItem value="hybrid">Hybrid (Anyone can view, members see portal)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-500 mt-1">
                {renameLayoutType === 'public' && 'Accessible to everyone with public header/footer layout'}
                {renameLayoutType === 'member' && 'Only logged-in members can access, displayed within the portal sidebar'}
                {renameLayoutType === 'hybrid' && 'Anyone can view; logged-in members see it within the portal sidebar'}
              </p>
            </div>
            {renameError && (
              <p className="text-sm text-destructive" data-testid="text-rename-error">{renameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRenameDialog(false)} data-testid="button-rename-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleRenameSubmit}
              disabled={updatePageMetaMutation.isPending}
              data-testid="button-rename-save"
            >
              {updatePageMetaMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
