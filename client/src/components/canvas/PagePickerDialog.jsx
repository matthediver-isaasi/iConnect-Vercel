import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Search, LayoutGrid, List, FileEdit } from "lucide-react";
import { DndContext } from "@dnd-kit/core";
import { adminFetch } from "@/lib/adminFetch";
import PageFolderSidebar, { PRIMARY_SITE } from "@/components/iedit/PageFolderSidebar";
import PageManagerItem from "@/components/iedit/PageManagerItem";

// Shares the page manager's view-mode preference so the grid/list toggle is
// persisted the same way across both surfaces.
const VIEW_MODE_KEY = "iedit-page-view-mode";

function getStatusBadge(status) {
  const variants = {
    draft: "bg-slate-100 text-slate-700",
    published: "bg-green-100 text-green-700",
    archived: "bg-warning/10 text-warning",
  };
  return variants[status] || variants.draft;
}

/**
 * Read-only internal-page picker for Canvas link fields (Task #2719).
 *
 * Reuses the /IEditPageManagement browsing experience — the folder + microsite
 * structure sidebar, the grid/list view toggle, and the search box — but the
 * page cards are display-only (no management actions). Clicking a page resolves
 * it to its internal link path (`/slug` for main-site pages, `/{prefix}/{slug}`
 * for microsite pages) and hands it back to the caller via `onPick`, then
 * closes.
 */
export default function PagePickerDialog({ open, onOpenChange, onPick }) {
  const [searchQuery, setSearchQuery] = useState("");
  // Active site context: null = primary tenant site, otherwise a microsite id.
  const [activeSiteId, setActiveSiteId] = useState(null);
  const [selectedFolderId, setSelectedFolderId] = useState("all"); // 'all' | 'root' | <folderId>
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "grid";
    } catch {
      return "grid";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      /* ignore */
    }
  }, [viewMode]);

  // Reset browse state each time the modal opens so it always starts at the
  // top-level "All pages" view.
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setActiveSiteId(null);
      setSelectedFolderId("all");
    }
  }, [open]);

  // Same data + query keys the management page uses, so the cache is shared.
  const { data: pages = [], isLoading } = useQuery({
    queryKey: ["iedit-pages"],
    queryFn: async () => {
      const result = await base44.entities.IEditPage.list();
      return Array.isArray(result) ? result : [];
    },
    enabled: open,
    staleTime: 0,
  });

  const { data: folders = [] } = useQuery({
    queryKey: ["iedit-page-folders"],
    queryFn: async () => {
      const result = await base44.entities.IEditPageFolder.list();
      return Array.isArray(result) ? result : [];
    },
    enabled: open,
    staleTime: 0,
  });

  const { data: microsites = [] } = useQuery({
    queryKey: ["admin-microsites"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/microsites", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return Array.isArray(data?.microsites) ? data.microsites : [];
    },
    enabled: open,
    staleTime: 30_000,
  });

  // Per-site page counts for the sidebar (mirrors the management page).
  const countFor = useMemo(() => {
    const bySite = new Map();
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
      if (viewKey === "all") return bucket.all;
      if (viewKey === "root") return bucket.root;
      return bucket.byFolder.get(viewKey) || 0;
    };
  }, [pages]);

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

  const micrositePrefixById = useMemo(() => {
    const map = {};
    for (const m of microsites) map[m.id] = m.path_prefix;
    return map;
  }, [microsites]);

  const visiblePages = useMemo(() => {
    const q = searchQuery.toLowerCase();
    let list = pages.filter(
      (page) =>
        page.title?.toLowerCase().includes(q) ||
        page.slug?.toLowerCase().includes(q) ||
        page.description?.toLowerCase().includes(q)
    );
    if (activeSiteId) {
      list = list.filter((p) => p.microsite_id === activeSiteId);
    } else {
      list = list.filter((p) => !p.microsite_id);
    }
    if (selectedFolderId === "root") {
      list = list.filter((p) => !p.folder_id);
    } else if (selectedFolderId !== "all") {
      list = list.filter((p) => p.folder_id === selectedFolderId);
    }
    const sorted = [...list].sort(
      (a, b) => new Date(b.updated_date || 0) - new Date(a.updated_date || 0)
    );
    const pinned = sorted.filter((p) => p.pinned_at);
    const unpinned = sorted.filter((p) => !p.pinned_at);
    return [...pinned, ...unpinned];
  }, [pages, searchQuery, activeSiteId, selectedFolderId]);

  // Resolve a page to its internal link path, respecting microsite prefixes.
  const resolvePagePath = (page) => {
    if (!page?.slug) return "";
    if (page.microsite_id) {
      const prefix = micrositePrefixById[page.microsite_id];
      if (prefix) return `/${prefix}/${page.slug}`;
    }
    return `/${page.slug}`;
  };

  const handleSelectPage = (page) => {
    const path = resolvePagePath(page);
    if (path) onPick?.(path);
    onOpenChange?.(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Link to a page</DialogTitle>
          <DialogDescription>
            Pick a page to use as this link's target.
          </DialogDescription>
        </DialogHeader>

        {/* Toolbar: search + view toggle */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
            <Input
              placeholder="Search pages by title, slug, or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search-picker-pages"
            />
          </div>
          <div className="flex items-center rounded-md border border-slate-200 overflow-hidden">
            <Button
              variant={viewMode === "grid" ? "default" : "ghost"}
              size="icon"
              className="rounded-none no-default-hover-elevate"
              onClick={() => setViewMode("grid")}
              title="Card view"
              data-testid="button-picker-view-grid"
            >
              <LayoutGrid className="w-4 h-4" />
            </Button>
            <Button
              variant={viewMode === "list" ? "default" : "ghost"}
              size="icon"
              className="rounded-none no-default-hover-elevate"
              onClick={() => setViewMode("list")}
              title="List view"
              data-testid="button-picker-view-list"
            >
              <List className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Sidebar + pages. A bare DndContext satisfies the drag/drop hooks
            used inside the shared sidebar + item components; no drop handlers
            are wired because this surface is browse-and-select only. */}
        <DndContext>
          <div className="flex flex-col md:flex-row gap-4 items-start max-h-[60vh]">
            <aside className="w-full md:w-56 flex-shrink-0 rounded-lg border border-slate-200 p-2 md:max-h-[60vh] md:overflow-y-auto">
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
                hideFolderActions
                onCreateFolder={() => {}}
                onCreateSubfolder={() => {}}
                onRename={() => {}}
                onDelete={() => {}}
              />
            </aside>

            <div className="flex-1 min-w-0 w-full md:max-h-[60vh] md:overflow-y-auto">
              {isLoading ? (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Array(6)
                    .fill(0)
                    .map((_, i) => (
                      <Card key={i} className="animate-pulse border-slate-200">
                        <CardContent className="p-6">
                          <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                          <div className="h-4 bg-slate-200 rounded w-full" />
                        </CardContent>
                      </Card>
                    ))}
                </div>
              ) : visiblePages.length === 0 ? (
                <Card className="border-slate-200">
                  <CardContent className="p-12 text-center">
                    <FileEdit className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">
                      {searchQuery ? "No pages found" : "No pages here"}
                    </h3>
                    <p className="text-sm text-slate-600">
                      {searchQuery
                        ? "Try adjusting your search query"
                        : "This view has no pages."}
                    </p>
                  </CardContent>
                </Card>
              ) : viewMode === "list" ? (
                <div className="space-y-2">
                  {visiblePages.map((page) => (
                    <PageManagerItem
                      key={page.id}
                      page={page}
                      viewMode="list"
                      selectMode
                      onSelectPage={handleSelectPage}
                      getStatusBadge={getStatusBadge}
                    />
                  ))}
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {visiblePages.map((page) => (
                    <PageManagerItem
                      key={page.id}
                      page={page}
                      viewMode="grid"
                      selectMode
                      onSelectPage={handleSelectPage}
                      getStatusBadge={getStatusBadge}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </DndContext>
      </DialogContent>
    </Dialog>
  );
}
