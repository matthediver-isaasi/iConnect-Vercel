
import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FileEdit, Plus, Search, LayoutGrid, List, ArrowUpDown } from "lucide-react";
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
import { useNavigate } from "react-router-dom";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import PageFolderSidebar from "@/components/iedit/PageFolderSidebar";
import PageManagerItem from "@/components/iedit/PageManagerItem";

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
  const [searchQuery, setSearchQuery] = useState("");
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
  });

  // Folder / view state (Task: folders, sorting & pinning)
  const [selectedFolderId, setSelectedFolderId] = useState("all"); // 'all' | 'root' | <folderId>
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });
  const [sortMap, setSortMap] = useState(() => loadSortMap());
  const [activeDragId, setActiveDragId] = useState(null);

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

  const currentSort = sortMap[selectedFolderId] || DEFAULT_SORT;

  const setSortForView = (value) => {
    setSortMap((prev) => {
      const next = { ...prev, [selectedFolderId]: value };
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
  const queryClient = useQueryClient();

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['iedit-pages'],
    queryFn: async () => {
      const result = await base44.entities.IEditPage.list();
      return Array.isArray(result) ? result : [];
    },
    staleTime: 0
  });

  const { data: folders = [] } = useQuery({
    queryKey: ['iedit-page-folders'],
    queryFn: async () => {
      const result = await base44.entities.IEditPageFolder.list();
      return Array.isArray(result) ? result : [];
    },
    staleTime: 0,
  });

  const createFolderMutation = useMutation({
    mutationFn: ({ name, parentId }) =>
      base44.entities.IEditPageFolder.create({
        name,
        parent_id: parentId || null,
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

  const movePageMutation = useMutation({
    mutationFn: ({ pageId, folderId }) =>
      base44.entities.IEditPage.update(pageId, { folder_id: folderId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['iedit-pages'] });
    },
    onError: (error) => toast.error('Failed to move page: ' + error.message),
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
      setNewPage({ title: "", slug: "", description: "", layout_type: "public", status: "draft", builder_type: "iedit", canvas_template_id: "" });
      toast.success('Page created successfully');
      const editorPage = created.builder_type === 'canvas' ? 'CanvasPageEditor' : 'IEditPageEditor';
      navigate(createPageUrl(editorPage) + `?pageId=${created.id}`);
    },
    onError: (error) => {
      toast.error('Failed to create page: ' + error.message);
    }
  });

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
      navigate(createPageUrl('CanvasPageEditor') + `?pageId=${created.id}`);
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
    if (newPage.builder_type === 'canvas' && newPage.canvas_template_id) {
      try {
        const r = await fetch(`/api/canvas-templates/${newPage.canvas_template_id}`, { credentials: 'include' });
        if (r.ok) {
          const body = await r.json();
          if (body?.template?.design) payload.canvas_design = body.template.design;
        }
      } catch {/* non-fatal — page will be created empty */}
    }

    createPageMutation.mutate(payload);
  };

  const handleDeletePage = () => {
    if (pageToDelete) {
      deletePageMutation.mutate(pageToDelete.id);
    }
  };

  // Page counts per view (ignores search so the sidebar shows folder sizes).
  const countFor = useMemo(() => {
    const byFolder = new Map();
    let rootCount = 0;
    for (const p of pages) {
      if (p.folder_id) {
        byFolder.set(p.folder_id, (byFolder.get(p.folder_id) || 0) + 1);
      } else {
        rootCount += 1;
      }
    }
    return (viewKey) => {
      if (viewKey === 'all') return pages.length;
      if (viewKey === 'root') return rootCount;
      return byFolder.get(viewKey) || 0;
    };
  }, [pages]);

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
  }, [pages, searchQuery, selectedFolderId, currentSort]);

  const filteredPages = visiblePages;

  const activePage = activeDragId
    ? pages.find((p) => `page:${p.id}` === activeDragId)
    : null;

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
    const overId = String(over.id);
    if (overId.startsWith('folder:')) {
      targetFolderId = overId.replace('folder:', '');
    } else if (overId === 'view:root') {
      targetFolderId = null;
    } else {
      return; // dropped somewhere that isn't a folder target
    }

    if ((page.folder_id || null) === (targetFolderId || null)) return;
    movePageMutation.mutate({ pageId, folderId: targetFolderId });
    const folderName = targetFolderId
      ? folders.find((f) => f.id === targetFolderId)?.name || 'folder'
      : 'Unfiled';
    toast.success(`Moved "${page.title}" to ${folderName}`);
  };

  const openCreateFolder = (parentId = null) => {
    setFolderDialog({ mode: 'create', parentId });
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
      createFolderMutation.mutate({ name, parentId: folderDialog?.parentId || null });
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
      <div className="max-w-7xl mx-auto">
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
          <Button onClick={() => setShowCreateDialog(true)} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            New Page
          </Button>
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
                folders={folders}
                selectedFolderId={selectedFolderId}
                onSelect={setSelectedFolderId}
                countFor={countFor}
                onCreateFolder={() => openCreateFolder(null)}
                onCreateSubfolder={(parent) => openCreateFolder(parent.id)}
                onRename={openRenameFolder}
                onDelete={setFolderToDelete}
              />
            </aside>

            <div className="flex-1 min-w-0 w-full">
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
                      homePageSlug={homePageSlug}
                      getStatusBadge={getStatusBadge}
                      onEdit={(p) => {
                        const editorPage = p.builder_type === 'canvas' ? 'CanvasPageEditor' : 'IEditPageEditor';
                        navigate(createPageUrl(editorPage) + `?pageId=${p.id}`);
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
                      homePageSlug={homePageSlug}
                      getStatusBadge={getStatusBadge}
                      onEdit={(p) => {
                        const editorPage = p.builder_type === 'canvas' ? 'CanvasPageEditor' : 'IEditPageEditor';
                        navigate(createPageUrl(editorPage) + `?pageId=${p.id}`);
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

          <DragOverlay>
            {activePage ? (
              <div className="rounded-md border border-blue-300 bg-white px-3 py-2 shadow-lg text-sm font-medium text-slate-800">
                {activePage.title}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

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
