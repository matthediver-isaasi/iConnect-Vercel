
import React, { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileEdit, Plus, Search, LayoutGrid, List, ArrowUpDown, FileText, Loader2, CheckCircle2, XCircle, MinusCircle, TrendingDown, TrendingUp, Minus, Globe, AlertCircle, AlertTriangle } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import PageFolderSidebar, { PRIMARY_SITE } from "@/components/iedit/PageFolderSidebar";
import { adminFetch } from "@/lib/adminFetch";
import PageManagerItem from "@/components/iedit/PageManagerItem";
import { Badge } from "@/components/ui/badge";
import CanvasPageRenderer from "@/components/canvas/CanvasPageRenderer";
import { extractSeedSwatches } from "@/lib/canvasSeedSwatches";
import { createEmptyCanvasDesign, CANVAS_FLOW_VERSION } from "@/lib/canvasDesign";

const VIEW_MODE_KEY = "iedit-page-view-mode";
const SORT_MAP_KEY = "iedit-page-sort-map";
const DEFAULT_SORT = "updated-desc";

const SORT_OPTIONS = [
  { value: "az", label: "Name A–Z" },
  { value: "za", label: "Name Z–A" },
  { value: "updated-desc", label: "Updated (newest)" },
  { value: "updated-asc", label: "Updated (oldest)" },
];

function loadSortMap() {
  try {
    const raw = localStorage.getItem(SORT_MAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Renders an up/down trend arrow comparing the current tenant-wide average
// against the previous ~30-day period (Task #2749). Fewer issues than before
// reads as an improvement (down arrow, green); more reads as a regression.
function AuditTrend({ current, previous, noun, testid }) {
  if (current == null || previous == null) return null;
  const delta = Math.round((current - previous) * 100) / 100;
  if (delta === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-slate-500"
        aria-label={`No change in average ${noun} versus the previous 30 days`}
        data-testid={testid}
      >
        <Minus className="w-3.5 h-3.5" />
        No change
      </span>
    );
  }
  const improving = delta < 0;
  const Icon = improving ? TrendingDown : TrendingUp;
  const magnitude = Math.abs(delta);
  const label = improving
    ? `Improving: ${magnitude} fewer ${noun} per page than the previous 30 days`
    : `Worsening: ${magnitude} more ${noun} per page than the previous 30 days`;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${
        improving
          ? "text-green-600 dark:text-green-400"
          : "text-red-600 dark:text-red-400"
      }`}
      aria-label={label}
      title={label}
      data-testid={testid}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {improving ? "−" : "+"}
      {magnitude}
    </span>
  );
}

// Formats a nullable average for display: "—" when no audited pages exist.
function fmtAvg(v) {
  return v == null ? "—" : v.toFixed(1);
}

// Scaled, fit-to-width preview of a generated Canvas design.
//
// The preview must be an accurate scaled-down copy of the page that will
// actually be built. The built page lays auto-height text out at the desktop
// stage width (1200px); if we let the design reflow to a narrower width the
// text wraps taller than the server reserved, so fixed-position dividers/
// titles below it overlap the text. To avoid that we:
//   1. Force the renderer to desktop geometry (`forceBreakpoint="desktop"`),
//      independent of the host window size, so text wraps exactly as built.
//   2. Lay the stage out at the true desktop width, then apply a single
//      uniform scale to shrink the whole stage to fit the dialog. The layout
//      width never depends on the dialog width, so blocks never re-wrap.
function DocPreviewStage({ design }) {
  const DESKTOP_W = 1200;
  const containerRef = useRef(null);
  const innerRef = useRef(null);
  const [containerW, setContainerW] = useState(DESKTOP_W);
  const [innerH, setInnerH] = useState(0);

  // Track the available width of the scroll container.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerW(el.clientWidth);
    measure();
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => { if (ro) ro.disconnect(); };
  }, []);

  // Track the natural (unscaled) height of the rendered stage so the outer
  // box can collapse to the scaled height (transforms don't affect layout).
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setInnerH(el.scrollHeight || el.offsetHeight || 0);
    measure();
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(el);
    }
    return () => { if (ro) ro.disconnect(); };
  }, [design]);

  const scale = containerW > 0 ? Math.min(1, containerW / DESKTOP_W) : 1;

  return (
    <div
      ref={containerRef}
      className="border rounded-md overflow-auto max-h-[55vh] min-w-0 bg-white"
      data-testid="container-doc-preview"
    >
      {/*
        The stage is laid out at DESKTOP_W (1200px) and shrunk with
        `transform: scale(...)`. A CSS transform only affects the element
        visually — its layout box stays 1200px wide, which forces the Radix
        grid `DialogContent` (grid items default to `min-width: auto`) open to
        ~1200px. Collapse this wrapper's layout footprint to the *scaled* size
        in BOTH dimensions (width and height) and clip overflow so the 1200px
        layout box no longer defines the intrinsic width.
      */}
      <div
        style={{
          width: DESKTOP_W * scale,
          height: innerH ? innerH * scale : undefined,
          overflow: 'hidden',
        }}
      >
        <div
          ref={innerRef}
          style={{ width: DESKTOP_W, transform: `scale(${scale})`, transformOrigin: 'top left' }}
        >
          <CanvasPageRenderer
            page={{ builder_type: 'canvas', canvas_design: design }}
            forceBreakpoint="desktop"
          />
        </div>
      </div>
    </div>
  );
}

export default function IEditPageManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.pages')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [searchQuery, setSearchQuery] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("q") || "";
    } catch {
      return "";
    }
  });
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pageToDelete, setPageToDelete] = useState(null);
  // Rename / change-slug dialog state (Task #979). Reachable for
  // canvas-builder rows from the page list, mirroring the editor's
  // header affordance.
  const [pageToRename, setPageToRename] = useState(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameSlug, setRenameSlug] = useState('');
  const [renameLayoutType, setRenameLayoutType] = useState('public');
  const [renameError, setRenameError] = useState('');
  const [newPage, setNewPage] = useState({
    title: "",
    slug: "",
    description: "",
    layout_type: "public",
    status: "draft",
    builder_type: "iedit",
    canvas_template_id: "",
    canvas_version: "v1",
  });

  // Create-from-document state.
  const [showDocDialog, setShowDocDialog] = useState(false);
  const [docFiles, setDocFiles] = useState([]); // File[] selected/dropped in upload mode
  const [docDragOver, setDocDragOver] = useState(false);
  // Batch (multi-file) auto-create progress. null = not running/not started.
  // Array<{ name, status: 'pending'|'processing'|'done'|'failed', error?, pageId? }>
  const [batchStatus, setBatchStatus] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [docTitle, setDocTitle] = useState("");
  const [docMode, setDocMode] = useState("upload"); // 'upload' | 'paste'
  const [docText, setDocText] = useState("");
  const [docSeedPageId, setDocSeedPageId] = useState("neutral"); // 'neutral' | <canvas page id>
  // Holds the generated-but-unsaved design returned by the preview step so the
  // admin can review it before anything is persisted. null = no preview yet.
  const [docPreview, setDocPreview] = useState(null);

  // Folder / view state (Task: folders, sorting & pinning)
  // Active site context (Task #2534): null = primary tenant site, otherwise a
  // microsite id. Drives both folder-panel selection and page-list filtering.
  const [activeSiteId, setActiveSiteId] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("site") || null;
    } catch {
      return null;
    }
  });
  const [selectedFolderId, setSelectedFolderId] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("folder") || "all";
    } catch {
      return "all";
    }
  }); // 'all' | 'root' | <folderId>
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [sortMap, setSortMap] = useState(() => loadSortMap());
  const [activeDragId, setActiveDragId] = useState(null);
  // Multi-select: set of selected page ids for bulk move (Task #2236).
  const [selectedPageIds, setSelectedPageIds] = useState(() => new Set());
  const [bulkMoveTarget, setBulkMoveTarget] = useState("");

  // Folder create / rename dialog state
  const [folderDialog, setFolderDialog] = useState(null); // { mode: 'create'|'rename', parentId, folder }
  const [folderName, setFolderName] = useState("");
  const [folderToDelete, setFolderToDelete] = useState(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      /* ignore */
    }
  }, [viewMode]);

  // Sort preference is scoped per (site, folder) view (Task #2534) so a
  // microsite folder can be sorted independently of a same-named primary view.
  const viewSortKey = `${activeSiteId || PRIMARY_SITE}:${selectedFolderId}`;
  const currentSort = sortMap[viewSortKey] || DEFAULT_SORT;

  const setSortForView = (value) => {
    setSortMap((prev) => {
      const next = { ...prev, [viewSortKey]: value };
      try {
        localStorage.setItem(SORT_MAP_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  // Templates list, loaded lazily when the user picks the Canvas builder.
  const { data: templatesData } = useQuery({
    queryKey: ['canvas-templates'],
    queryFn: async () => {
      const r = await fetch('/api/canvas-templates', { credentials: 'include' });
      if (!r.ok) return { templates: [] };
      return r.json();
    },
    enabled: showCreateDialog && newPage.builder_type === 'canvas',
    staleTime: 30_000,
  });

  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  // Keep the URL in sync with the active view (microsite + folder + search) so
  // the list is restorable purely from the URL — both on reload/deep-link and
  // when returning from the editor's back arrow (Task #2661). Uses the same
  // null / 'all' / 'root' semantics as the state itself; default values are
  // omitted from the query string to keep the primary/unfiled URL clean.
  useEffect(() => {
    const params = new URLSearchParams();
    if (activeSiteId) params.set('site', activeSiteId);
    if (selectedFolderId && selectedFolderId !== 'all') params.set('folder', selectedFolderId);
    if (searchQuery) params.set('q', searchQuery);
    setSearchParams(params, { replace: true });
  }, [activeSiteId, selectedFolderId, searchQuery, setSearchParams]);

  // Encodes the current list view so the editor can send the user back to the
  // exact microsite/folder/search they left when they click the back arrow.
  const buildListReturnTo = () => {
    const params = new URLSearchParams();
    if (activeSiteId) params.set('site', activeSiteId);
    if (selectedFolderId && selectedFolderId !== 'all') params.set('folder', selectedFolderId);
    if (searchQuery) params.set('q', searchQuery);
    const qs = params.toString();
    return createPageUrl('IEditPageManagement') + (qs ? `?${qs}` : '');
  };

  // Builds the editor URL for a page, carrying the current view context so the
  // editor's back arrow can restore it.
  const buildEditorUrl = (editorPage, pageId) =>
    createPageUrl(editorPage) +
    `?pageId=${pageId}&returnTo=${encodeURIComponent(buildListReturnTo())}`;

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['iedit-pages'],
    queryFn: async () => {
      const result = await base44.entities.IEditPage.list();
      return Array.isArray(result) ? result : [];
    },
    staleTime: 0
  });

  // Canvas pages usable as a "seed" style reference in the doc-import dialog.
  // Each carries a small set of extracted brand swatches (accent / hero / band)
  // so an admin can tell the pages apart visually before generating.
  const canvasSeedPages = useMemo(
    () =>
      (Array.isArray(pages) ? pages : [])
        .filter((p) => p?.builder_type === 'canvas')
        .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
        .map((p) => ({ ...p, swatches: extractSeedSwatches(p.canvas_design) })),
    [pages]
  );

  const { data: folders = [] } = useQuery({
    queryKey: ['iedit-page-folders'],
    queryFn: async () => {
      const result = await base44.entities.IEditPageFolder.list();
      return Array.isArray(result) ? result : [];
    },
    staleTime: 0,
  });

  // Tenant microsites (Task #2534). Used to render the "Microsites" section in
  // the folder panel and to scope page/folder filtering by microsite.
  const { data: microsites = [] } = useQuery({
    queryKey: ['admin-microsites'],
    queryFn: async () => {
      const res = await adminFetch('/api/admin/microsites', { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return Array.isArray(data?.microsites) ? data.microsites : [];
    },
    staleTime: 30_000,
  });

  // Per-page audit + last-edit meta and tenant-wide stats (Task #2749).
  // One bulk request keeps the grid fast regardless of page count.
  const { data: pageMeta } = useQuery({
    queryKey: ['iedit-page-management-meta'],
    queryFn: async () => {
      const res = await adminFetch('/api/admin/page-management-meta', { credentials: 'include' });
      if (!res.ok) return { pages: {}, stats: null };
      const data = await res.json().catch(() => ({}));
      return {
        pages: data?.pages && typeof data.pages === 'object' ? data.pages : {},
        stats: data?.stats || null,
      };
    },
    staleTime: 30_000,
  });
  const pageMetaById = pageMeta?.pages || {};
  const pageStats = pageMeta?.stats || null;

  const createFolderMutation = useMutation({
    mutationFn: ({ name, parentId, micrositeId }) =>
      base44.entities.IEditPageFolder.create({
        name,
        parent_id: parentId || null,
        microsite_id: micrositeId || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-page-folders'] });
      setFolderDialog(null);
      setFolderName("");
      toast.success('Folder created');
    },
    onError: (error) => toast.error('Failed to create folder: ' + error.message),
  });

  const renameFolderMutation = useMutation({
    mutationFn: ({ id, name }) =>
      base44.entities.IEditPageFolder.update(id, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-page-folders'] });
      setFolderDialog(null);
      setFolderName("");
      toast.success('Folder renamed');
    },
    onError: (error) => toast.error('Failed to rename folder: ' + error.message),
  });

  // Deleting a folder does NOT delete its pages: the DB FK on
  // i_edit_page.folder_id is ON DELETE SET NULL, so filed pages fall back to
  // the Unfiled/root view. Nested subfolders cascade (parent_id ON DELETE
  // CASCADE) and their pages likewise fall to root.
  const deleteFolderMutation = useMutation({
    mutationFn: (id) => base44.entities.IEditPageFolder.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-page-folders'] });
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      if (folderToDelete && selectedFolderId === folderToDelete.id) {
        setSelectedFolderId('all');
      }
      setFolderToDelete(null);
      toast.success('Folder deleted. Its pages moved to Unfiled.');
    },
    onError: (error) => toast.error('Failed to delete folder: ' + error.message),
  });

  // Moves one or more pages to a folder (or Unfiled when folderId is null).
  // Optimistically updates the cached pages so dropped cards disappear from the
  // current folder view instantly, rolling back on failure so the card
  // reappears with an error toast (Task #2236).
  const movePagesMutation = useMutation({
    mutationFn: ({ pageIds, folderId }) =>
      Promise.all(
        pageIds.map((id) =>
          base44.entities.IEditPage.update(id, { folder_id: folderId })
        )
      ),
    onMutate: async ({ pageIds, folderId }) => {
      await queryClient.cancelQueries({ queryKey: ['iedit-pages'] });
      const previous = queryClient.getQueryData(['iedit-pages']);
      const idSet = new Set(pageIds);
      queryClient.setQueryData(['iedit-pages'], (old) =>
        Array.isArray(old)
          ? old.map((p) =>
              idSet.has(p.id) ? { ...p, folder_id: folderId } : p
            )
          : old
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['iedit-pages'], context.previous);
      }
      toast.error('Failed to move page: ' + error.message);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
    },
  });

  const togglePinMutation = useMutation({
    mutationFn: (page) =>
      base44.entities.IEditPage.update(page.id, {
        pinned_at: page.pinned_at ? null : new Date().toISOString(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
    },
    onError: (error) => toast.error('Failed to update pin: ' + error.message),
  });

  // Query for current home page setting
  const { data: homePageSlug } = useQuery({
    queryKey: ['home-page-setting'],
    queryFn: async () => {
      const result = await base44.entities.SystemSettings.list();
      const settings = Array.isArray(result) ? result : [];
      const homeSetting = settings.find(s => s.setting_key === 'public_home_page_slug');
      return homeSetting?.setting_value || null;
    },
    staleTime: 0
  });

  const createPageMutation = useMutation({
    mutationFn: (pageData) => base44.entities.IEditPage.create(pageData),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      setShowCreateDialog(false);
      setNewPage({ title: "", slug: "", description: "", layout_type: "public", status: "draft", builder_type: "iedit", canvas_template_id: "", canvas_version: "v1" });
      toast.success('Page created successfully');
      const editorPage = created.builder_type === 'canvas' ? 'CanvasPageEditor' : 'IEditPageEditor';
      navigate(buildEditorUrl(editorPage, created.id));
    },
    onError: (error) => {
      toast.error('Failed to create page: ' + error.message);
    }
  });

  const resetDocDialog = () => {
    setShowDocDialog(false);
    setDocFiles([]);
    setDocDragOver(false);
    setBatchStatus(null);
    setBatchRunning(false);
    setDocTitle("");
    setDocText("");
    setDocMode("upload");
    setDocSeedPageId("neutral");
    setDocPreview(null);
  };

  // Read a File into base64 (payload for /api/admin/canvas-from-doc).
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });

  // Add .docx files to the batch, de-duplicating by name+size.
  const addDocFiles = (fileList) => {
    const incoming = Array.from(fileList || []).filter((f) => /\.docx$/i.test(f.name));
    if (!incoming.length) return;
    setDocFiles((prev) => {
      const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
      const merged = [...prev];
      for (const f of incoming) {
        const key = `${f.name}:${f.size}`;
        if (!seen.has(key)) { seen.add(key); merged.push(f); }
      }
      return merged;
    });
  };

  // Multi-file path: process each document with its own single-request
  // generate-and-create call so no serverless invocation handles the whole
  // batch (avoids the Vercel 60s limit). Sequential so slug uniqueness stays
  // race-free. One shared branding (seed page / neutral) for every file; each
  // page's title comes from its own filename. A single failure does not abort
  // the rest of the batch.
  const runBatchCreate = async () => {
    const files = docFiles;
    if (!files.length) return;
    const seed = docSeedPageId && docSeedPageId !== 'neutral' ? docSeedPageId : undefined;
    setBatchRunning(true);
    setBatchStatus(files.map((f) => ({ name: f.name, status: 'pending' })));
    let created = 0;
    let failed = 0;
    for (let i = 0; i < files.length; i++) {
      setBatchStatus((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'processing' } : s)));
      try {
        const fileBase64 = await fileToBase64(files[i]);
        const res = await fetch('/api/admin/canvas-from-doc', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileBase64, filename: files[i].name, ...(seed ? { seedPageId: seed } : {}) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Failed to create page');
        created += 1;
        setBatchStatus((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'done', pageId: data?.page?.id } : s)));
      } catch (err) {
        failed += 1;
        setBatchStatus((prev) => prev.map((s, idx) => (idx === i ? { ...s, status: 'failed', error: err.message } : s)));
      }
    }
    setBatchRunning(false);
    queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
    if (created > 0) {
      toast.success(`Created ${created} page${created === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
    } else {
      toast.error(`Failed to create ${failed} page${failed === 1 ? '' : 's'}`);
    }
  };

  // Step 1 — generate a design from an uploaded file OR pasted text WITHOUT
  // saving anything. The admin reviews the result before it is persisted.
  const fromDocPreviewMutation = useMutation({
    mutationFn: async ({ file, text, title, seedPageId }) => {
      const seed = seedPageId && seedPageId !== 'neutral' ? seedPageId : undefined;
      let payload;
      if (file) {
        const fileBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(new Error('Could not read the file'));
          reader.readAsDataURL(file);
        });
        payload = { fileBase64, filename: file.name, title: title || undefined, seedPageId: seed, preview: true };
      } else {
        payload = { text, title: title || undefined, seedPageId: seed, preview: true };
      }
      const res = await fetch('/api/admin/canvas-from-doc', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to generate a preview from the content');
      return data;
    },
    onSuccess: (data, vars) => setDocPreview({
      ...data,
      seedPageId: vars?.seedPageId && vars.seedPageId !== 'neutral' ? vars.seedPageId : undefined,
    }),
    onError: (error) => toast.error(error.message),
  });

  // Step 2 — persist the previewed design. Only this step creates a page row.
  const fromDocConfirmMutation = useMutation({
    mutationFn: async (preview) => {
      const res = await fetch('/api/admin/canvas-from-doc', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: true,
          design: preview.design,
          title: preview.title,
          slug: preview.slug,
          ...(preview.seedPageId ? { seedPageId: preview.seedPageId } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to create page from document');
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      resetDocDialog();
      toast.success('Page created');
      if (data?.page?.id) navigate(buildEditorUrl('CanvasPageEditor', data.page.id));
    },
    onError: (error) => toast.error(error.message),
  });

  const docBusy = fromDocPreviewMutation.isPending || fromDocConfirmMutation.isPending || batchRunning;

  const createLoginPageMutation = useMutation({
    mutationFn: () => {
      const defaultDesign = {
        version: 1,
        root: {
          background: null,
          sections: [{
            id: 'root-section',
            children: [{
              id: 'lf-' + Date.now(),
              type: 'login-form',
              name: 'Login Form',
              locked: false,
              style: { background: 'transparent', borderWidth: 0, opacity: 1, zIndex: 1 },
              a11y: { role: null, ariaLabel: null },
              content: {},
              bp: { desktop: { x: 376, y: 130, w: 448, h: 520 } },
            }],
          }],
        },
      };
      return base44.entities.IEditPage.create({
        title: 'Login',
        slug: 'login',
        description: 'Custom login page',
        layout_type: 'public_no_chrome',
        status: 'draft',
        builder_type: 'canvas',
        canvas_design: defaultDesign,
      });
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      toast.success('Login page created — add your design, then publish it');
      navigate(buildEditorUrl('CanvasPageEditor', created.id));
    },
    onError: (error) => {
      toast.error('Failed to create login page: ' + error.message);
    },
  });

  const deletePageMutation = useMutation({
    mutationFn: async (pageId) => {
      const allElements = await base44.entities.IEditPageElement.filter({ page_id: pageId });
      for (const element of allElements) {
        await base44.entities.IEditPageElement.delete(element.id);
      }
      await base44.entities.IEditPage.delete(pageId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      setShowDeleteDialog(false);
      setPageToDelete(null);
      toast.success('Page deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete page: ' + error.message);
    }
  });

  const togglePublishMutation = useMutation({
    mutationFn: async (page) => {
      const newStatus = page.status === 'published' ? 'draft' : 'published';
      const updateData = { 
        status: newStatus,
        published_at: newStatus === 'published' ? new Date().toISOString() : null
      };
      await base44.entities.IEditPage.update(page.id, updateData);
      // Phase 7 — every publish creates a version snapshot, regardless of
      // which surface initiated it. This keeps rollback-on-publish
      // available for pages published from the list view as well as the
      // canvas editor. Failures here are non-fatal: the publish itself
      // already succeeded.
      if (newStatus === 'published' && page.builder_type === 'canvas') {
        try {
          await fetch(`/api/canvas-versions/${page.id}`, {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'publish', label: `Published ${new Date().toLocaleString()}` }),
          });
        } catch { /* snapshot best-effort */ }
      }
      return { ...page, ...updateData };
    },
    onSuccess: (updatedPage) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      if (updatedPage.status === 'published') {
        toast.success(`Page published! Now live at ${window.location.origin}/${updatedPage.slug}`);
      } else {
        toast.success('Page unpublished and returned to draft');
      }
    },
    onError: (error) => {
      toast.error('Failed to update page status: ' + error.message);
    }
  });

  const renamePageMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.IEditPage.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      setPageToRename(null);
      setRenameError('');
      toast.success('Page updated');
    },
    onError: (error) => {
      toast.error('Failed to update page: ' + (error?.message || 'Unknown error'));
    },
  });

  const openRenameDialog = (page) => {
    setPageToRename(page);
    setRenameTitle(page.title || '');
    setRenameSlug(page.slug || '');
    setRenameLayoutType(page.layout_type || 'public');
    setRenameError('');
  };

  const failRename = (msg) => {
    setRenameError(msg);
    toast.error(msg);
  };

  const handleRenameSubmit = async () => {
    if (!pageToRename) return;
    if (pageToRename.slug === 'login') return;
    const title = (renameTitle || '').trim();
    const slug = (renameSlug || '').trim().toLowerCase();
    if (!title) { failRename('Title is required'); return; }
    if (!slug) { failRename('Slug is required'); return; }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      failRename('Slug must be lowercase letters, numbers, and hyphens only');
      return;
    }
    const others = pages.filter((p) => p.id !== pageToRename.id);
    if (others.some((p) => (p.slug || '').toLowerCase() === slug)) {
      failRename('Another page already uses this slug');
      return;
    }
    const layoutType = ['public', 'member', 'hybrid'].includes(renameLayoutType) ? renameLayoutType : 'public';
    setRenameError('');
    try {
      await renamePageMutation.mutateAsync({ id: pageToRename.id, data: { title, slug, layout_type: layoutType } });
    } catch (error) {
      // Mutation's onError already showed a toast; mirror the message
      // inline in the dialog so the author sees it without dismissing.
      setRenameError(error?.message || 'Failed to update page');
    }
  };

  const duplicatePageMutation = useMutation({
    mutationFn: async (page) => {
      // Generate a unique slug by adding -copy or incrementing number
      let newSlug = `${page.slug}-copy`;
      const existingSlugs = pages.map(p => p.slug);
      let counter = 1;
      while (existingSlugs.includes(newSlug)) {
        newSlug = `${page.slug}-copy-${counter}`;
        counter++;
      }

      // Create the new page (as draft). builder_type and canvas_design must
      // be carried over so duplicating a Canvas Builder page produces another
      // Canvas page with the same design document; otherwise the new row
      // would default to 'iedit' and lose its layout.
      const newPageData = {
        title: `${page.title} (Copy)`,
        slug: newSlug,
        description: page.description || '',
        layout_type: page.layout_type || 'public',
        status: 'draft',
        meta_title: page.meta_title,
        meta_description: page.meta_description,
        builder_type: page.builder_type || 'iedit',
        canvas_design: page.canvas_design || null,
      };

      const createdPage = await base44.entities.IEditPage.create(newPageData);

      // Canvas pages don't use i_edit_page_element rows; their design lives
      // entirely in canvas_design (copied above). Only the iEdit builder
      // needs the per-element copy.
      if ((page.builder_type || 'iedit') === 'iedit') {
        const originalElements = await base44.entities.IEditPageElement.filter({ page_id: page.id });
        for (const element of originalElements) {
          const { id, page_id, created_date, updated_date, ...elementData } = element;
          await base44.entities.IEditPageElement.create({
            ...elementData,
            page_id: createdPage.id
          });
        }
      }

      return createdPage;
    },
    onSuccess: (newPage) => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
      toast.success(`Page duplicated! New page: "${newPage.title}"`);
    },
    onError: (error) => {
      toast.error('Failed to duplicate page: ' + error.message);
    }
  });

  // Mutation to toggle home page
  const toggleHomePageMutation = useMutation({
    mutationFn: async (page) => {
      // If this page is already the home page, remove it
      const isCurrentlyHome = homePageSlug === page.slug;
      const newSlug = isCurrentlyHome ? '' : page.slug;
      
      // Use dedicated function endpoint for reliability
      const response = await fetch('/api/functions/setPublicHomePage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: newSlug })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update home page');
      }
      
      return { slug: newSlug, wasHome: isCurrentlyHome };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['home-page-setting'] });
      if (result.wasHome) {
        toast.success('Home page removed. Default Events page will be shown.');
      } else {
        toast.success(`Home page set! Visitors to the root URL will now see /${result.slug}`);
      }
    },
    onError: (error) => {
      toast.error('Failed to update home page: ' + error.message);
    }
  });

  const handleCreatePage = async () => {
    if (!newPage.title.trim() || !newPage.slug.trim()) {
      toast.error('Title and slug are required');
      return;
    }

    const slugRegex = /^[a-z0-9-]+$/;
    if (!slugRegex.test(newPage.slug)) {
      toast.error('Slug must be lowercase with hyphens only (no spaces or special characters)');
      return;
    }

    // If the user picked a Canvas template, pre-fetch the template design
    // so the new page is created with canvas_design already populated.
    const payload = { ...newPage };
    delete payload.canvas_template_id;
    // `canvas_version` is a create-dialog-only rollout aid (Task #2678) and is
    // not an entity field — strip it before sending the create payload.
    delete payload.canvas_version;
    if (newPage.builder_type === 'canvas' && newPage.canvas_template_id) {
      try {
        const r = await fetch(`/api/canvas-templates/${newPage.canvas_template_id}`, { credentials: 'include' });
        if (r.ok) {
          const body = await r.json();
          if (body?.template?.design) payload.canvas_design = body.template.design;
        }
      } catch {/* non-fatal — page will be created empty */}
    } else if (newPage.builder_type === 'canvas' && newPage.canvas_version === 'v2') {
      // Temporary rollout aid (Task #2678): start a blank Canvas page directly
      // in v2 (auto-layout / flow) mode. Seeding canvas_design here means the
      // editor hydrates the stored flow design instead of overwriting it with
      // an empty v1 design on first load, and isFlowDesign() returns true so
      // the "Upgrade to auto-layout" button is hidden.
      payload.canvas_design = createEmptyCanvasDesign(CANVAS_FLOW_VERSION);
    }

    createPageMutation.mutate(payload);
  };

  const handleDeletePage = () => {
    if (pageToDelete) {
      deletePageMutation.mutate(pageToDelete.id);
    }
  };

  // Page counts per view (ignores search so the sidebar shows folder sizes).
  // Per-site page counts (Task #2534). Each site (primary or a microsite)
  // gets its own all / root / per-folder tallies so the counts shown next to
  // each view are scoped to the correct site context.
  const countFor = useMemo(() => {
    const bySite = new Map(); // key: micrositeId || PRIMARY_SITE
    const ensure = (key) => {
      if (!bySite.has(key)) bySite.set(key, { all: 0, root: 0, byFolder: new Map() });
      return bySite.get(key);
    };
    for (const p of pages) {
      const bucket = ensure(p.microsite_id || PRIMARY_SITE);
      bucket.all += 1;
      if (p.folder_id) {
        bucket.byFolder.set(p.folder_id, (bucket.byFolder.get(p.folder_id) || 0) + 1);
      } else {
        bucket.root += 1;
      }
    }
    return (viewKey, siteId) => {
      const bucket = bySite.get(siteId || PRIMARY_SITE);
      if (!bucket) return 0;
      if (viewKey === 'all') return bucket.all;
      if (viewKey === 'root') return bucket.root;
      return bucket.byFolder.get(viewKey) || 0;
    };
  }, [pages]);

  // Folders partitioned by site context (Task #2534).
  const primaryFolders = useMemo(
    () => folders.filter((f) => !f.microsite_id),
    [folders]
  );
  const micrositeFoldersById = useMemo(() => {
    const map = {};
    for (const f of folders) {
      if (f.microsite_id) (map[f.microsite_id] ||= []).push(f);
    }
    return map;
  }, [folders]);
  const contextFolders = activeSiteId
    ? micrositeFoldersById[activeSiteId] || []
    : primaryFolders;

  const sortPages = (list, sortMode) => {
    const arr = [...list];
    const byName = (a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' });
    const byUpdated = (a, b) =>
      new Date(b.updated_date || 0) - new Date(a.updated_date || 0);
    switch (sortMode) {
      case 'az': arr.sort(byName); break;
      case 'za': arr.sort((a, b) => byName(b, a)); break;
      case 'updated-asc': arr.sort((a, b) => byUpdated(b, a)); break;
      case 'updated-desc':
      default: arr.sort(byUpdated); break;
    }
    return arr;
  };

  const visiblePages = useMemo(() => {
    const q = searchQuery.toLowerCase();
    let list = pages.filter((page) =>
      page.title?.toLowerCase().includes(q) ||
      page.slug?.toLowerCase().includes(q) ||
      page.description?.toLowerCase().includes(q)
    );
    // Site context (Task #2534): primary shows pages with no microsite_id;
    // a microsite context shows only that microsite's pages.
    if (activeSiteId) {
      list = list.filter((p) => p.microsite_id === activeSiteId);
    } else {
      list = list.filter((p) => !p.microsite_id);
    }
    if (selectedFolderId === 'root') {
      list = list.filter((p) => !p.folder_id);
    } else if (selectedFolderId !== 'all') {
      list = list.filter((p) => p.folder_id === selectedFolderId);
    }
    const sorted = sortPages(list, currentSort);
    // Pinned pages float to the top of the view, preserving the chosen sort
    // order within the pinned and unpinned groups.
    const pinned = sorted.filter((p) => p.pinned_at);
    const unpinned = sorted.filter((p) => !p.pinned_at);
    return [...pinned, ...unpinned];
  }, [pages, searchQuery, selectedFolderId, activeSiteId, currentSort]);

  const filteredPages = visiblePages;

  // Clear any selection when the folder view changes (Task #2236).
  useEffect(() => {
    setSelectedPageIds(new Set());
  }, [selectedFolderId, activeSiteId]);

  const togglePageSelected = (pageId) => {
    setSelectedPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  };

  const clearSelection = () => setSelectedPageIds(new Set());

  const folderNameFor = (folderId) =>
    folderId
      ? folders.find((f) => f.id === folderId)?.name || 'folder'
      : 'Unfiled';

  // Shared move helper for both drag-and-drop and the bulk action bar. Skips
  // pages already in the target folder, fires one optimistic mutation, shows a
  // success toast and clears the selection.
  const movePagesToFolder = (pageIds, targetFolderId) => {
    const idsToMove = pageIds.filter((id) => {
      const p = pages.find((pg) => pg.id === id);
      return p && (p.folder_id || null) !== (targetFolderId || null);
    });
    if (idsToMove.length === 0) {
      clearSelection();
      return;
    }
    movePagesMutation.mutate({ pageIds: idsToMove, folderId: targetFolderId });
    const folderName = folderNameFor(targetFolderId);
    if (idsToMove.length === 1) {
      const p = pages.find((pg) => pg.id === idsToMove[0]);
      toast.success(`Moved "${p?.title || 'page'}" to ${folderName}`);
    } else {
      toast.success(`Moved ${idsToMove.length} pages to ${folderName}`);
    }
    clearSelection();
  };

  const activePage = activeDragId
    ? pages.find((p) => `page:${p.id}` === activeDragId)
    : null;
  // Number of pages that will move with the current drag: the whole selection
  // when the dragged card is part of it, otherwise just the single card.
  const activeDragCount =
    activePage && selectedPageIds.has(activePage.id)
      ? selectedPageIds.size
      : 1;

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const handleDragEnd = (event) => {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const pageId = String(active.id).replace('page:', '');
    const page = pages.find((p) => p.id === pageId);
    if (!page) return;

    let targetFolderId = null;
    let targetSite = null; // null = primary site, else micrositeId
    const overId = String(over.id);
    if (overId.startsWith('folder:')) {
      targetFolderId = overId.replace('folder:', '');
      const folder = folders.find((f) => f.id === targetFolderId);
      targetSite = folder?.microsite_id || null;
    } else if (overId.startsWith('siteview:')) {
      // siteview:<site>:<view> — site is PRIMARY_SITE or a micrositeId; only
      // the "root" (Unfiled) view is a valid drop target.
      const rest = overId.slice('siteview:'.length);
      const sep = rest.lastIndexOf(':');
      const sitePart = rest.slice(0, sep);
      const viewPart = rest.slice(sep + 1);
      if (viewPart !== 'root') return;
      targetSite = sitePart === PRIMARY_SITE ? null : sitePart;
      targetFolderId = null;
    } else {
      return; // dropped somewhere that isn't a folder target
    }

    // Task #2534: folder moves never change a page's microsite assignment.
    // Only allow dropping a page into a folder/view within its OWN site.
    if ((page.microsite_id || null) !== (targetSite || null)) {
      toast.error("You can only move a page within its own site's folders.");
      return;
    }

    // If the dragged page is part of the current selection, move the whole
    // selection; otherwise move just the dragged page.
    const idsToMove = selectedPageIds.has(pageId)
      ? Array.from(selectedPageIds)
      : [pageId];
    movePagesToFolder(idsToMove, targetFolderId);
  };

  const openCreateFolder = ({ parentId = null, micrositeId = null } = {}) => {
    setFolderDialog({ mode: 'create', parentId, micrositeId });
    setFolderName('');
  };
  const openRenameFolder = (folder) => {
    setFolderDialog({ mode: 'rename', folder });
    setFolderName(folder.name || '');
  };
  const handleFolderSubmit = () => {
    const name = folderName.trim();
    if (!name) {
      toast.error('Folder name is required');
      return;
    }
    if (folderDialog?.mode === 'rename') {
      renameFolderMutation.mutate({ id: folderDialog.folder.id, name });
    } else {
      createFolderMutation.mutate({
        name,
        parentId: folderDialog?.parentId || null,
        micrositeId: folderDialog?.micrositeId || null,
      });
    }
  };

  const getStatusBadge = (status) => {
    const variants = {
      draft: "bg-slate-100 text-slate-700",
      published: "bg-green-100 text-green-700",
      archived: "bg-warning/10 text-warning"
    };
    return variants[status] || variants.draft;
  };

  const getPublicUrl = (slug) => {
    // Dynamic pages are accessed via their slug directly as a route
    return `/${slug}`;
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Page Editor
            </h1>
            <p className="text-slate-600">
              Create and manage custom pages with drag-and-drop elements
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => setShowDocDialog(true)}
              data-testid="button-create-from-doc"
            >
              <FileText className="w-4 h-4 mr-2" />
              From content
            </Button>
            <Button onClick={() => setShowCreateDialog(true)} className="bg-blue-600 hover:bg-blue-700" data-testid="button-new-page">
              <Plus className="w-4 h-4 mr-2" />
              New Page
            </Button>
          </div>
        </div>

        {/* Custom login page prompt — shown when no canvas login page exists */}
        {!isLoading && !pages.some(p => p.slug === 'login' && p.builder_type === 'canvas') && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 mb-6 flex flex-wrap items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-blue-900 mb-0.5">Customise your login page</p>
              <p className="text-xs text-blue-700">
                Design a branded <code>/login</code> page in CanvasBuilder. Members will see it instead of the default form once you publish it.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => createLoginPageMutation.mutate()}
              disabled={createLoginPageMutation.isPending}
              data-testid="button-create-login-page"
            >
              {createLoginPageMutation.isPending ? 'Creating…' : 'Create Login Page'}
            </Button>
          </div>
        )}

        {/* Toolbar: search + sort + view toggle */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-6 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search pages by title, slug, or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-pages"
            />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" data-testid="button-sort-menu">
                <ArrowUpDown className="w-4 h-4 mr-2" />
                {SORT_OPTIONS.find((o) => o.value === currentSort)?.label || 'Sort'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {SORT_OPTIONS.map((o) => (
                <DropdownMenuItem
                  key={o.value}
                  onClick={() => setSortForView(o.value)}
                  className={currentSort === o.value ? 'font-semibold' : ''}
                  data-testid={`sort-option-${o.value}`}
                >
                  {o.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="flex items-center rounded-md border border-slate-200 overflow-hidden">
            <Button
              variant={viewMode === 'grid' ? 'default' : 'ghost'}
              size="icon"
              className="rounded-none no-default-hover-elevate"
              onClick={() => setViewMode('grid')}
              title="Card view"
              data-testid="button-view-grid"
            >
              <LayoutGrid className="w-4 h-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="icon"
              className="rounded-none no-default-hover-elevate"
              onClick={() => setViewMode('list')}
              title="List view"
              data-testid="button-view-list"
            >
              <List className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Stats bar (Task #2749): tenant-wide page/audit totals + trend */}
        {pageStats && (
          <div
            className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6"
            data-testid="bar-page-stats"
          >
            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
                  <FileText className="w-4 h-4" />
                  Total pages
                </div>
                <div
                  className="text-2xl font-bold text-slate-900"
                  data-testid="stat-total-pages"
                >
                  {pageStats.totalPages}
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
                  <Globe className="w-4 h-4" />
                  Microsites
                </div>
                <div
                  className="text-2xl font-bold text-slate-900"
                  data-testid="stat-microsite-count"
                >
                  {pageStats.micrositeCount}
                </div>
                <div
                  className="text-xs text-slate-500 mt-1"
                  data-testid="stat-pages-in-microsites"
                >
                  {pageStats.pagesInMicrosites}{" "}
                  {pageStats.pagesInMicrosites === 1 ? "page" : "pages"} in
                  microsites
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
                  <AlertCircle className="w-4 h-4" />
                  Avg errors / page
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-2xl font-bold text-slate-900"
                    data-testid="stat-avg-errors"
                  >
                    {fmtAvg(pageStats.avgErrors)}
                  </span>
                  <AuditTrend
                    current={pageStats.avgErrors}
                    previous={pageStats.prevAvgErrors}
                    noun="errors"
                    testid="trend-avg-errors"
                  />
                </div>
              </CardContent>
            </Card>

            <Card className="border-slate-200">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
                  <AlertTriangle className="w-4 h-4" />
                  Avg warnings / page
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-2xl font-bold text-slate-900"
                    data-testid="stat-avg-warnings"
                  >
                    {fmtAvg(pageStats.avgWarnings)}
                  </span>
                  <AuditTrend
                    current={pageStats.avgWarnings}
                    previous={pageStats.prevAvgWarnings}
                    noun="warnings"
                    testid="trend-avg-warnings"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Folders + pages */}
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragStart={(e) => setActiveDragId(String(e.active.id))}
          onDragCancel={() => setActiveDragId(null)}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-col md:flex-row gap-6 items-start">
            <aside className="w-full md:w-64 flex-shrink-0 bg-white rounded-xl shadow-sm border border-slate-200 p-3">
              <PageFolderSidebar
                primaryFolders={primaryFolders}
                microsites={microsites}
                micrositeFoldersById={micrositeFoldersById}
                selectedSiteId={activeSiteId}
                selectedFolderId={selectedFolderId}
                onSelect={(siteId, folderId) => {
                  setActiveSiteId(siteId);
                  setSelectedFolderId(folderId);
                }}
                countFor={countFor}
                onCreateFolder={(siteId) =>
                  openCreateFolder({ micrositeId: siteId })
                }
                onCreateSubfolder={(parent) =>
                  openCreateFolder({
                    parentId: parent.id,
                    micrositeId: parent.microsite_id || null,
                  })
                }
                onRename={openRenameFolder}
                onDelete={setFolderToDelete}
              />
            </aside>

            <div className="flex-1 min-w-0 w-full">
              {selectedPageIds.size > 0 && (
                <div
                  className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3"
                  data-testid="bar-bulk-actions"
                >
                  <span
                    className="text-sm font-medium text-blue-900"
                    data-testid="text-selected-count"
                  >
                    {selectedPageIds.size} selected
                  </span>
                  <div className="flex items-center gap-2 ml-auto flex-wrap">
                    <Select
                      value={bulkMoveTarget}
                      onValueChange={(value) => {
                        setBulkMoveTarget("");
                        movePagesToFolder(
                          Array.from(selectedPageIds),
                          value === 'root' ? null : value
                        );
                      }}
                    >
                      <SelectTrigger
                        className="w-56 bg-white"
                        data-testid="select-bulk-move-target"
                      >
                        <SelectValue placeholder="Move to folder..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="root">Unfiled</SelectItem>
                        {contextFolders.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={clearSelection}
                      className="bg-white"
                      data-testid="button-clear-selection"
                    >
                      Clear selection
                    </Button>
                  </div>
                </div>
              )}
              {isLoading ? (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {Array(6).fill(0).map((_, i) => (
                    <Card key={i} className="animate-pulse border-slate-200">
                      <CardHeader>
                        <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                        <div className="h-4 bg-slate-200 rounded w-full" />
                      </CardHeader>
                    </Card>
                  ))}
                </div>
              ) : filteredPages.length === 0 ? (
                <Card className="border-slate-200">
                  <CardContent className="p-12 text-center">
                    <FileEdit className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-xl font-semibold text-slate-900 mb-2">
                      {searchQuery ? 'No Pages Found' : 'No Pages Yet'}
                    </h3>
                    <p className="text-slate-600 mb-6">
                      {searchQuery
                        ? 'Try adjusting your search query'
                        : selectedFolderId !== 'all' && selectedFolderId !== 'root'
                        ? 'This folder is empty. Drag pages here to file them.'
                        : 'Create your first custom page to get started'}
                    </p>
                    {!searchQuery && selectedFolderId === 'all' && (
                      <Button onClick={() => setShowCreateDialog(true)} className="bg-blue-600 hover:bg-blue-700">
                        <Plus className="w-4 h-4 mr-2" />
                        Create First Page
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ) : viewMode === 'list' ? (
                <div className="space-y-2">
                  {filteredPages.map((page) => (
                    <PageManagerItem
                      key={page.id}
                      page={page}
                      viewMode="list"
                      pageMeta={pageMetaById[page.id] || null}
                      selected={selectedPageIds.has(page.id)}
                      onToggleSelect={() => togglePageSelected(page.id)}
                      homePageSlug={homePageSlug}
                      getStatusBadge={getStatusBadge}
                      onEdit={(p) => {
                        const editorPage = p.builder_type === 'canvas' ? 'CanvasPageEditor' : 'IEditPageEditor';
                        navigate(buildEditorUrl(editorPage, p.id));
                      }}
                      onOpenPublic={(p) => window.open(getPublicUrl(p.slug), '_blank')}
                      onRename={openRenameDialog}
                      onDuplicate={(p) => duplicatePageMutation.mutate(p)}
                      onDelete={(p) => { setPageToDelete(p); setShowDeleteDialog(true); }}
                      onTogglePublish={(p) => togglePublishMutation.mutate(p)}
                      onToggleHome={(p) => toggleHomePageMutation.mutate(p)}
                      onTogglePin={(p) => togglePinMutation.mutate(p)}
                      duplicatePending={duplicatePageMutation.isPending}
                      publishPending={togglePublishMutation.isPending}
                      homePending={toggleHomePageMutation.isPending}
                      pinPending={togglePinMutation.isPending}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredPages.map((page) => (
                    <PageManagerItem
                      key={page.id}
                      page={page}
                      viewMode="grid"
                      pageMeta={pageMetaById[page.id] || null}
                      selected={selectedPageIds.has(page.id)}
                      onToggleSelect={() => togglePageSelected(page.id)}
                      homePageSlug={homePageSlug}
                      getStatusBadge={getStatusBadge}
                      onEdit={(p) => {
                        const editorPage = p.builder_type === 'canvas' ? 'CanvasPageEditor' : 'IEditPageEditor';
                        navigate(buildEditorUrl(editorPage, p.id));
                      }}
                      onOpenPublic={(p) => window.open(getPublicUrl(p.slug), '_blank')}
                      onRename={openRenameDialog}
                      onDuplicate={(p) => duplicatePageMutation.mutate(p)}
                      onDelete={(p) => { setPageToDelete(p); setShowDeleteDialog(true); }}
                      onTogglePublish={(p) => togglePublishMutation.mutate(p)}
                      onToggleHome={(p) => toggleHomePageMutation.mutate(p)}
                      onTogglePin={(p) => togglePinMutation.mutate(p)}
                      duplicatePending={duplicatePageMutation.isPending}
                      publishPending={togglePublishMutation.isPending}
                      homePending={toggleHomePageMutation.isPending}
                      pinPending={togglePinMutation.isPending}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          <DragOverlay dropAnimation={null}>
            {activePage ? (
              <div className="rounded-md border border-blue-300 bg-white px-3 py-2 shadow-lg text-sm font-medium text-slate-800">
                {activeDragCount > 1
                  ? `${activeDragCount} pages`
                  : activePage.title}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {/* Create From Document Dialog */}
        <Dialog open={showDocDialog} onOpenChange={(o) => { if (!docBusy) { if (o) setShowDocDialog(true); else resetDocDialog(); } }}>
          <DialogContent className={docPreview ? "max-w-3xl" : "max-w-md"}>
            <DialogHeader>
              <DialogTitle>
                {batchStatus ? 'Creating pages' : docPreview ? 'Review generated page' : 'Create page from content'}
              </DialogTitle>
            </DialogHeader>

            {batchStatus ? (
              <>
                <div className="space-y-3">
                  <p className="text-sm text-slate-600">
                    Each document is turned into its own draft Canvas page using the shared branding. You can leave this running — it processes one file at a time.
                  </p>
                  <div className="max-h-72 overflow-y-auto space-y-1" data-testid="container-batch-progress">
                    {batchStatus.map((s, i) => (
                      <div
                        key={`${s.name}-${i}`}
                        className="flex items-center gap-3 rounded-md p-2"
                        data-testid={`row-batch-${i}`}
                      >
                        {s.status === 'done' ? (
                          <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
                        ) : s.status === 'failed' ? (
                          <XCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                        ) : s.status === 'processing' ? (
                          <Loader2 className="w-4 h-4 text-blue-600 flex-shrink-0 animate-spin" />
                        ) : (
                          <MinusCircle className="w-4 h-4 text-slate-400 flex-shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-slate-800 truncate">{s.name}</p>
                          {s.status === 'failed' && s.error && (
                            <p className="text-xs text-destructive truncate">{s.error}</p>
                          )}
                        </div>
                        <span className="text-xs text-slate-500 flex-shrink-0" data-testid={`status-batch-${i}`}>
                          {s.status === 'done'
                            ? 'Done'
                            : s.status === 'failed'
                            ? 'Failed'
                            : s.status === 'processing'
                            ? 'Processing…'
                            : 'Pending'}
                        </span>
                      </div>
                    ))}
                  </div>
                  {!batchRunning && (
                    <p className="text-sm text-slate-600" data-testid="text-batch-summary">
                      {(() => {
                        const done = batchStatus.filter((s) => s.status === 'done').length;
                        const failed = batchStatus.filter((s) => s.status === 'failed').length;
                        return `Created ${done} page${done === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.`;
                      })()}
                    </p>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={resetDocDialog}
                    disabled={batchRunning}
                    data-testid="button-batch-close"
                  >
                    {batchRunning ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating pages…</>
                    ) : 'Close'}
                  </Button>
                </DialogFooter>
              </>
            ) : !docPreview ? (
              <>
                <div className="space-y-4">
                  <p className="text-sm text-slate-600">
                    Upload one or more Word documents, or paste your text (for example from Google Docs). A single file (or pasted text) lets you review before saving; drop several files to create a draft page for each one automatically.
                  </p>
                  <Tabs value={docMode} onValueChange={setDocMode}>
                    <TabsList className="grid w-full grid-cols-2">
                      <TabsTrigger value="upload" data-testid="tab-doc-upload">Upload file(s)</TabsTrigger>
                      <TabsTrigger value="paste" data-testid="tab-doc-paste">Paste text</TabsTrigger>
                    </TabsList>
                    <TabsContent value="upload" className="space-y-2 mt-4">
                      <Label htmlFor="doc-file">Word documents (.docx)</Label>
                      <div
                        onDragOver={(e) => { e.preventDefault(); setDocDragOver(true); }}
                        onDragLeave={(e) => { e.preventDefault(); setDocDragOver(false); }}
                        onDrop={(e) => { e.preventDefault(); setDocDragOver(false); addDocFiles(e.dataTransfer?.files); }}
                        className={`rounded-md border-2 border-dashed p-4 text-center transition-colors ${docDragOver ? 'border-blue-400 bg-blue-50' : 'border-slate-300'}`}
                        data-testid="dropzone-doc-files"
                      >
                        <p className="text-sm text-slate-600 mb-2">Drag &amp; drop .docx files here, or</p>
                        <Input
                          id="doc-file"
                          type="file"
                          multiple
                          accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                          onChange={(e) => { addDocFiles(e.target.files); e.target.value = ''; }}
                          data-testid="input-doc-file"
                        />
                      </div>
                      {docFiles.length > 0 && (
                        <div className="space-y-1 max-h-40 overflow-y-auto" data-testid="list-doc-files">
                          {docFiles.map((f, i) => (
                            <div
                              key={`${f.name}-${f.size}-${i}`}
                              className="flex items-center gap-2 rounded-md bg-slate-50 px-2 py-1"
                              data-testid={`row-doc-file-${i}`}
                            >
                              <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
                              <span className="text-xs text-slate-600 flex-1 min-w-0 truncate">{f.name}</span>
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => setDocFiles((prev) => prev.filter((_, idx) => idx !== i))}
                                data-testid={`button-remove-doc-file-${i}`}
                              >
                                <XCircle className="w-4 h-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                      {docFiles.length > 1 && (
                        <p className="text-xs text-slate-500" data-testid="text-doc-multi-note">
                          {docFiles.length} files selected. Each becomes its own draft page (titled from its filename) using the shared branding below.
                        </p>
                      )}
                    </TabsContent>
                    <TabsContent value="paste" className="space-y-2 mt-4">
                      <Label htmlFor="doc-text">Paste your text</Label>
                      <Textarea
                        id="doc-text"
                        placeholder="Paste content from Google Docs, an email, or anywhere else…"
                        value={docText}
                        onChange={(e) => setDocText(e.target.value)}
                        className="min-h-40 resize-y"
                        data-testid="input-doc-text"
                      />
                    </TabsContent>
                  </Tabs>
                  <div className="space-y-2">
                    <Label htmlFor="doc-title">Page title (optional)</Label>
                    <Input
                      id="doc-title"
                      placeholder="Leave blank to use the content's heading"
                      value={docTitle}
                      onChange={(e) => setDocTitle(e.target.value)}
                      data-testid="input-doc-title"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="doc-seed">Match the style of</Label>
                    <Select value={docSeedPageId} onValueChange={setDocSeedPageId}>
                      <SelectTrigger id="doc-seed" data-testid="select-doc-seed">
                        <SelectValue placeholder="Neutral (use tenant brand colours)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="neutral" data-testid="option-doc-seed-neutral">
                          Neutral (use tenant brand colours)
                        </SelectItem>
                        {canvasSeedPages.map((p) => (
                          <SelectItem key={p.id} value={p.id} data-testid={`option-doc-seed-${p.id}`}>
                            <span className="flex items-center gap-2">
                              {p.swatches?.length > 0 && (
                                <span className="flex shrink-0 items-center" data-testid={`swatches-doc-seed-${p.id}`}>
                                  {p.swatches.map((color, i) => (
                                    <span
                                      key={i}
                                      className="h-3.5 w-3.5 rounded-full border border-black/10 -ml-1 first:ml-0"
                                      style={{ background: color }}
                                    />
                                  ))}
                                </span>
                              )}
                              <span>{p.title || 'Untitled page'}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-slate-500">
                      Copies an existing Canvas page's colours, hero style, fonts, and buttons onto the new page.
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={resetDocDialog} disabled={docBusy}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => {
                      if (docMode === 'upload') {
                        if (docFiles.length > 1) {
                          runBatchCreate();
                        } else if (docFiles.length === 1) {
                          fromDocPreviewMutation.mutate({ file: docFiles[0], title: docTitle.trim(), seedPageId: docSeedPageId });
                        }
                      } else if (docText.trim()) {
                        fromDocPreviewMutation.mutate({ text: docText.trim(), title: docTitle.trim(), seedPageId: docSeedPageId });
                      }
                    }}
                    disabled={docBusy || (docMode === 'upload' ? docFiles.length === 0 : !docText.trim())}
                    data-testid="button-submit-from-doc"
                  >
                    {fromDocPreviewMutation.isPending ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating preview…</>
                    ) : docMode === 'upload' && docFiles.length > 1 ? (
                      `Create ${docFiles.length} pages`
                    ) : 'Generate preview'}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <div className="space-y-3 min-w-0 overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-slate-800" data-testid="text-preview-title">{docPreview.title}</span>
                    <Badge variant="secondary" data-testid="badge-preview-blocks">
                      {docPreview.blockCount} block{docPreview.blockCount === 1 ? '' : 's'}
                    </Badge>
                    {docPreview.summary?.sectionCount != null && (
                      <Badge variant="secondary" data-testid="badge-preview-sections">
                        {docPreview.summary.sectionCount} section{docPreview.summary.sectionCount === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-600">
                    This preview hasn't been saved yet. Confirm to create the draft page, or cancel to discard it — nothing is stored until you confirm.
                  </p>
                  {docPreview.layout === 'plain' && (
                    <p className="text-sm text-slate-500" data-testid="text-preview-plain-layout">
                      This page uses a simple layout that keeps every word from your content exactly as supplied. You can restyle it in the editor after creating it.
                    </p>
                  )}
                  <DocPreviewStage design={docPreview.design} />
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setDocPreview(null)}
                    disabled={docBusy}
                    data-testid="button-preview-back"
                  >
                    Back
                  </Button>
                  <Button
                    variant="outline"
                    onClick={resetDocDialog}
                    disabled={docBusy}
                    data-testid="button-preview-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => fromDocConfirmMutation.mutate(docPreview)}
                    disabled={docBusy}
                    data-testid="button-confirm-from-doc"
                  >
                    {fromDocConfirmMutation.isPending ? (
                      <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating page…</>
                    ) : 'Confirm & create page'}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* Create Page Dialog */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Create New Page</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="title">Page Title *</Label>
                <Input
                  id="title"
                  value={newPage.title}
                  onChange={(e) => {
                    const title = e.target.value;
                    setNewPage({
                      ...newPage,
                      title,
                      slug: newPage.slug === '' ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : newPage.slug
                    });
                  }}
                  placeholder="e.g., About Our Organisation"
                />
              </div>

              <div>
                <Label htmlFor="slug">URL Slug *</Label>
                <Input
                  id="slug"
                  value={newPage.slug}
                  onChange={(e) => setNewPage({ ...newPage, slug: e.target.value.toLowerCase() })}
                  placeholder="e.g., about-our-organisation"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Lowercase letters, numbers, and hyphens only
                </p>
              </div>

              <div>
                <Label htmlFor="description">Description (Optional)</Label>
                <Textarea
                  id="description"
                  value={newPage.description}
                  onChange={(e) => setNewPage({ ...newPage, description: e.target.value })}
                  placeholder="Brief description for admin reference..."
                  rows={3}
                />
              </div>

              <div>
                <Label htmlFor="builder_type">Builder</Label>
                <Select
                  value={newPage.builder_type}
                  onValueChange={(value) => setNewPage({ ...newPage, builder_type: value })}
                >
                  <SelectTrigger data-testid="select-builder-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="iedit">iEdit (stacked elements)</SelectItem>
                    <SelectItem value="canvas">Canvas (free-form drag &amp; drop)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  {newPage.builder_type === 'iedit' && 'Stacked element-based page editor. Recommended for most content pages.'}
                  {newPage.builder_type === 'canvas' && 'Free-form drag-and-drop canvas with per-breakpoint layouts. The builder cannot be changed after the page is created.'}
                </p>
              </div>

              {newPage.builder_type === 'canvas' && (
                <div>
                  <Label htmlFor="canvas_template_id">Start from template (optional)</Label>
                  <Select
                    value={newPage.canvas_template_id || 'blank'}
                    onValueChange={(value) => setNewPage({ ...newPage, canvas_template_id: value === 'blank' ? '' : value })}
                  >
                    <SelectTrigger data-testid="select-canvas-template">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blank">Blank page</SelectItem>
                      {(templatesData?.templates || []).map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}{t.is_starter ? ' (Starter)' : ''}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500 mt-1">
                    Templates copy their layout into the new page so you can keep editing without affecting the template.
                  </p>
                </div>
              )}

              {/* Temporary rollout aid (Task #2678): let the author start a
                  Canvas page directly in v2 (auto-layout / flow) mode instead of
                  the v1 default. Only meaningful for a blank page — a template
                  brings its own version. Remove this selector once v2 flow is
                  confirmed working and becomes the default. */}
              {newPage.builder_type === 'canvas' && !newPage.canvas_template_id && (
                <div>
                  <Label htmlFor="canvas_version">Canvas version (temporary rollout option)</Label>
                  <Select
                    value={newPage.canvas_version}
                    onValueChange={(value) => setNewPage({ ...newPage, canvas_version: value })}
                  >
                    <SelectTrigger data-testid="select-canvas-version">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="v1">v1 — Absolute positioning (current default)</SelectItem>
                      <SelectItem value="v2">v2 — Auto-layout / flow (rollout)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-slate-500 mt-1">
                    Temporary option while auto-layout is rolling out. v2 starts the page in flow mode with the &quot;Upgrade to auto-layout&quot; button already hidden.
                  </p>
                </div>
              )}

              <div>
                <Label htmlFor="layout_type">View Type</Label>
                <Select
                  value={newPage.layout_type}
                  onValueChange={(value) => setNewPage({ ...newPage, layout_type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public (Anyone can view, public layout)</SelectItem>
                    <SelectItem value="member">Portal (Members only, with sidebar)</SelectItem>
                    <SelectItem value="hybrid">Hybrid (Anyone can view, members see portal)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 mt-1">
                  {newPage.layout_type === 'public' && 'Accessible to everyone with public header/footer layout'}
                  {newPage.layout_type === 'member' && 'Only logged-in members can access, displayed within the portal sidebar'}
                  {newPage.layout_type === 'hybrid' && 'Anyone can view; logged-in members see it within the portal sidebar'}
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreatePage}
                disabled={createPageMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Create & Edit
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rename / Change Slug Dialog (Task #979) */}
        <Dialog open={!!pageToRename} onOpenChange={(open) => {
          if (!open) { setPageToRename(null); setRenameError(''); }
        }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Edit page settings</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {pageToRename?.slug === 'login' && (
                <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  The <strong>Login</strong> page is a system page. Its name and URL (<code>/login</code>) are locked so members can always find the sign-in form.
                </div>
              )}
              <div>
                <Label htmlFor="rename-list-title">Page Title *</Label>
                <Input
                  id="rename-list-title"
                  value={renameTitle}
                  onChange={(e) => setRenameTitle(e.target.value)}
                  disabled={pageToRename?.slug === 'login'}
                  data-testid="input-rename-list-title"
                />
              </div>
              <div>
                <Label htmlFor="rename-list-slug">URL Slug *</Label>
                <Input
                  id="rename-list-slug"
                  value={renameSlug}
                  onChange={(e) => setRenameSlug(e.target.value.toLowerCase())}
                  disabled={pageToRename?.slug === 'login'}
                  data-testid="input-rename-list-slug"
                />
                {pageToRename?.slug !== 'login' && (
                  <p className="text-xs text-slate-500 mt-1">
                    Lowercase letters, numbers, and hyphens only
                  </p>
                )}
              </div>
              {pageToRename?.slug !== 'login' && (
                <div>
                  <Label htmlFor="rename-list-layout-type">View Type</Label>
                  <Select value={renameLayoutType} onValueChange={setRenameLayoutType}>
                    <SelectTrigger id="rename-list-layout-type" data-testid="select-rename-list-layout-type">
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
              )}
              {renameError && (
                <p className="text-sm text-destructive" data-testid="text-rename-list-error">{renameError}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPageToRename(null)} data-testid="button-rename-list-cancel">
                {pageToRename?.slug === 'login' ? 'Close' : 'Cancel'}
              </Button>
              {pageToRename?.slug !== 'login' && (
                <Button
                  onClick={handleRenameSubmit}
                  disabled={renamePageMutation.isPending}
                  data-testid="button-rename-list-save"
                >
                  {renamePageMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete Page</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-slate-600">
                Are you sure you want to delete <strong>{pageToDelete?.title}</strong>? 
                This will also delete all elements on this page. This action cannot be undone.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleDeletePage}
                disabled={deletePageMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Page
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Folder create / rename dialog */}
        <Dialog
          open={!!folderDialog}
          onOpenChange={(open) => {
            if (!open) { setFolderDialog(null); setFolderName(''); }
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {folderDialog?.mode === 'rename' ? 'Rename Folder' : 'New Folder'}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="folder-name">Folder name *</Label>
                <Input
                  id="folder-name"
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleFolderSubmit(); }}
                  placeholder="e.g., Marketing pages"
                  autoFocus
                  data-testid="input-folder-name"
                />
                {folderDialog?.mode === 'create' && folderDialog?.parentId && (
                  <p className="text-xs text-slate-500 mt-1">
                    Will be created inside{' '}
                    <strong>
                      {folders.find((f) => f.id === folderDialog.parentId)?.name || 'the selected folder'}
                    </strong>.
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => { setFolderDialog(null); setFolderName(''); }}
                data-testid="button-folder-cancel"
              >
                Cancel
              </Button>
              <Button
                onClick={handleFolderSubmit}
                disabled={createFolderMutation.isPending || renameFolderMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-folder-save"
              >
                {folderDialog?.mode === 'rename' ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Folder delete confirmation */}
        <Dialog
          open={!!folderToDelete}
          onOpenChange={(open) => { if (!open) setFolderToDelete(null); }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete Folder</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <p className="text-slate-600">
                Delete <strong>{folderToDelete?.name}</strong>? Any pages inside
                (and inside its subfolders) will move to <strong>Unfiled</strong> —
                no pages are deleted. Subfolders will be removed.
              </p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setFolderToDelete(null)} data-testid="button-folder-delete-cancel">
                Cancel
              </Button>
              <Button
                onClick={() => folderToDelete && deleteFolderMutation.mutate(folderToDelete.id)}
                disabled={deleteFolderMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-folder-delete-confirm"
              >
                Delete Folder
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
