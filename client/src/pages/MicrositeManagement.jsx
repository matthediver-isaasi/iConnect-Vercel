import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { adminFetch } from "@/lib/adminFetch";
import { base44 } from "@/api/base44Client";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import MicrositeChromeEditor from "@/components/microsites/MicrositeChromeEditor";
import {
  Plus, Globe, Trash2, Pencil, ExternalLink, Loader2, PanelTop, FileText, List,
  ChevronDown, ChevronRight, ChevronUp, PanelLeftClose, PanelLeftOpen,
} from "lucide-react";
import {
  MAX_NAV_DEPTH, buildNavTree, collectDescendants, isInSubtree, getItemDepth, getHierarchyPrefix,
} from "@/components/navigation/navTreeUtils";

/**
 * Microsite management (Task #2523: moved from /admin/microsites to the main
 * portal, gated by the `site-builder.micro-sites` RBAC feature so tenants can
 * grant it to non-admin roles via Role Management).
 *
 * Microsites are groups of public pages served under /{prefix}/{slug} with
 * their own header, footer and navigation. This page covers:
 *  - list / create / edit / delete microsites
 *  - assigning pages into a microsite
 *  - microsite-scoped navigation items
 *  - header/footer overrides (any field left empty falls back to the tenant
 *    default at render time)
 */

const NAV_LOCATIONS = [
  { value: "main_nav", label: "Main navigation" },
  { value: "top_nav", label: "Top bar" },
  { value: "footer", label: "Footer" },
];

const EMPTY_FORM = {
  name: "",
  path_prefix: "",
  description: "",
  is_active: true,
  logo_url: "",
  home_page_id: "",
};

async function readJson(res) {
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export default function MicrositeManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [selectedId, setSelectedId] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(true);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('site-builder.micro-sites')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: micrositesData, isLoading } = useQuery({
    queryKey: ["admin-microsites"],
    queryFn: async () => {
      const res = await adminFetch("/api/admin/microsites", { credentials: "include" });
      const data = await readJson(res);
      return data.microsites || [];
    },
    enabled: accessChecked,
  });
  const microsites = micrositesData || [];
  const selected = useMemo(
    () => microsites.find((m) => m.id === selectedId) || null,
    [microsites, selectedId]
  );

  const { data: pagesData } = useQuery({
    queryKey: ["admin-microsite-pages"],
    queryFn: async () => {
      const result = await base44.entities.IEditPage.list();
      return Array.isArray(result) ? result : [];
    },
    enabled: accessChecked,
  });
  const pages = pagesData || [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-microsites"] });
    queryClient.invalidateQueries({ queryKey: ["public-microsites"] });
  };

  const saveMutation = useMutation({
    mutationFn: async ({ id, payload }) => {
      const res = await adminFetch(
        id ? `/api/admin/microsites?id=${id}` : "/api/admin/microsites",
        {
          method: id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          credentials: "include",
        }
      );
      return readJson(res);
    },
    onSuccess: (data) => {
      invalidate();
      setDialogOpen(false);
      if (data?.microsite?.id) setSelectedId(data.microsite.id);
      toast({ title: "Microsite saved" });
    },
    onError: (e) => toast({ title: "Could not save microsite", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const res = await adminFetch(`/api/admin/microsites?id=${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      return readJson(res);
    },
    onSuccess: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["iedit-pages"] });
      queryClient.invalidateQueries({ queryKey: ["admin-microsite-pages"] });
      setDeleteTarget(null);
      setSelectedId(null);
      toast({ title: "Microsite deleted", description: "Its pages were returned to the default site." });
    },
    onError: (e) => toast({ title: "Could not delete microsite", description: e.message, variant: "destructive" }),
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (m) => {
    setEditingId(m.id);
    setForm({
      name: m.name || "",
      path_prefix: m.path_prefix || "",
      description: m.description || "",
      is_active: m.is_active !== false,
      logo_url: m.logo_url || "",
      home_page_id: m.home_page_id || "",
    });
    setDialogOpen(true);
  };

  const submitForm = (e) => {
    e.preventDefault();
    saveMutation.mutate({
      id: editingId,
      payload: {
        name: form.name,
        path_prefix: form.path_prefix,
        description: form.description,
        is_active: form.is_active,
        logo_url: form.logo_url || null,
        home_page_id: form.home_page_id || null,
      },
    });
  };

  const micrositePages = useMemo(
    () => (selected ? pages.filter((p) => p.microsite_id === selected.id) : []),
    [pages, selected]
  );

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center py-24" data-testid="loading-access-check">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-8">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-6">
        <div className="flex items-start gap-3 min-w-0">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setDrawerOpen((o) => !o)}
            title={drawerOpen ? "Hide microsite list" : "Show microsite list"}
            aria-label={drawerOpen ? "Hide microsite list" : "Show microsite list"}
            data-testid="button-toggle-drawer"
          >
            {drawerOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </Button>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold" data-testid="text-microsites-title">Microsites</h1>
            <p className="text-sm text-muted-foreground">
              Groups of public pages served under their own URL prefix with their own header, footer and navigation.
            </p>
          </div>
        </div>
        <Button onClick={openCreate} data-testid="button-create-microsite">
          <Plus className="w-4 h-4 mr-2" /> New microsite
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center" data-testid="loading-microsites">
          <Loader2 className="w-5 h-5 animate-spin" /> Loading microsites…
        </div>
      ) : microsites.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Globe className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="font-medium mb-1" data-testid="text-no-microsites">No microsites yet</p>
            <p className="text-sm text-muted-foreground mb-4">
              Create one to serve a set of pages under its own URL section, e.g. <code>/summit/…</code>
            </p>
            <Button onClick={openCreate} data-testid="button-create-first-microsite">
              <Plus className="w-4 h-4 mr-2" /> Create microsite
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col lg:flex-row gap-4 items-start">
          {drawerOpen && (
            <aside className="w-full lg:w-72 lg:shrink-0 space-y-2" data-testid="drawer-microsites">
              {microsites.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedId(m.id)}
                  className={`w-full text-left rounded-md border p-3 hover-elevate ${
                    selectedId === m.id ? "border-foreground/30 bg-muted" : "border-border bg-card"
                  }`}
                  data-testid={`card-microsite-${m.id}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-medium">{m.name}</span>
                    {m.is_active === false && <Badge variant="secondary">Inactive</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground mt-0.5">/{m.path_prefix}/…</div>
                </button>
              ))}
            </aside>
          )}

          <div className="flex-1 min-w-0 w-full">
            {!selected ? (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground" data-testid="text-select-microsite">
                  Select a microsite to manage its pages, navigation and chrome.
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div>
                      <CardTitle data-testid="text-selected-name">{selected.name}</CardTitle>
                      <CardDescription>
                        Pages live at <code>/{selected.path_prefix}/&#123;page-slug&#125;</code>
                      </CardDescription>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <Button variant="outline" onClick={() => openEdit(selected)} data-testid="button-edit-microsite">
                        <Pencil className="w-4 h-4 mr-2" /> Edit
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setDeleteTarget(selected)}
                        data-testid="button-delete-microsite"
                      >
                        <Trash2 className="w-4 h-4 mr-2" /> Delete
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs defaultValue="pages">
                    <TabsList>
                      <TabsTrigger value="pages" data-testid="tab-pages">
                        <FileText className="w-4 h-4 mr-1.5" /> Pages
                      </TabsTrigger>
                      <TabsTrigger value="navigation" data-testid="tab-navigation">
                        <List className="w-4 h-4 mr-1.5" /> Navigation
                      </TabsTrigger>
                      <TabsTrigger value="chrome" data-testid="tab-chrome">
                        <PanelTop className="w-4 h-4 mr-1.5" /> Header &amp; Footer
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="pages">
                      <MicrositePagesTab
                        microsite={selected}
                        pages={pages}
                        micrositePages={micrositePages}
                      />
                    </TabsContent>
                    <TabsContent value="navigation">
                      <MicrositeNavTab microsite={selected} micrositePages={micrositePages} />
                    </TabsContent>
                    <TabsContent value="chrome">
                      <MicrositeChromeTab microsite={selected} />
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit microsite" : "New microsite"}</DialogTitle>
            <DialogDescription>
              The URL prefix is a single path segment, e.g. <code>summit</code> → <code>/summit/…</code>
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitForm} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ms-name">Name</Label>
              <Input
                id="ms-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Annual Summit"
                required
                data-testid="input-microsite-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ms-prefix">URL prefix</Label>
              <Input
                id="ms-prefix"
                value={form.path_prefix}
                onChange={(e) => setForm((f) => ({ ...f, path_prefix: e.target.value.toLowerCase() }))}
                placeholder="summit"
                required
                data-testid="input-microsite-prefix"
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers and hyphens. Cannot be a reserved route (admin, events, …) or an existing page slug.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ms-desc">Description (optional)</Label>
              <Textarea
                id="ms-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                data-testid="input-microsite-description"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ms-logo">Logo URL (optional — overrides tenant logo in the microsite header)</Label>
              <Input
                id="ms-logo"
                value={form.logo_url}
                onChange={(e) => setForm((f) => ({ ...f, logo_url: e.target.value }))}
                placeholder="https://…"
                data-testid="input-microsite-logo"
              />
            </div>
            {editingId && (
              <div className="space-y-2">
                <Label>Home page</Label>
                <Select
                  value={form.home_page_id || "none"}
                  onValueChange={(v) => setForm((f) => ({ ...f, home_page_id: v === "none" ? "" : v }))}
                >
                  <SelectTrigger data-testid="select-home-page">
                    <SelectValue placeholder="No home page" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No home page</SelectItem>
                    {pages
                      .filter((p) => p.microsite_id === editingId)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.title || p.slug}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">The microsite logo links here. Choose from pages assigned to this microsite.</p>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch
                checked={form.is_active}
                onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))}
                data-testid="switch-microsite-active"
              />
              <Label>Active</Label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} data-testid="button-cancel-microsite">
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending} data-testid="button-save-microsite">
                {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete microsite?</DialogTitle>
            <DialogDescription>
              "{deleteTarget?.name}" will be removed. Its pages return to the default site (served at their
              bare slug again) and its navigation items are deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete microsite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MicrositePagesTab({ microsite, pages, micrositePages }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState(null);
  const [pageSearch, setPageSearch] = useState("");

  const assignMutation = useMutation({
    mutationFn: async ({ pageId, micrositeId }) => {
      setPendingId(pageId);
      return base44.entities.IEditPage.update(pageId, { microsite_id: micrositeId });
    },
    onSettled: () => setPendingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-microsite-pages"] });
      queryClient.invalidateQueries({ queryKey: ["iedit-pages"] });
    },
    onError: (e) => toast({ title: "Could not update page", description: e.message, variant: "destructive" }),
  });

  const availablePages = pages.filter((p) => !p.microsite_id);
  const trimmedSearch = pageSearch.trim().toLowerCase();
  const filteredAvailablePages = trimmedSearch
    ? availablePages.filter((p) => {
        const title = (p.title || "").toLowerCase();
        const slug = (p.slug || "").toLowerCase();
        return title.includes(trimmedSearch) || slug.includes(trimmedSearch);
      })
    : availablePages;

  return (
    <div className="space-y-6 pt-4">
      <div>
        <h3 className="font-medium mb-2">Pages in this microsite</h3>
        {micrositePages.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-no-assigned-pages">
            No pages assigned yet. Assign pages below — each is then served at /{microsite.path_prefix}/&#123;slug&#125;.
          </p>
        ) : (
          <div className="space-y-2">
            {micrositePages.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between gap-2 flex-wrap rounded-md border p-3"
                data-testid={`row-assigned-page-${p.id}`}
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.title || p.slug}</div>
                  <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                    <span>/{microsite.path_prefix}/{p.slug}</span>
                    {p.status !== "published" && <Badge variant="secondary">{p.status}</Badge>}
                    {microsite.home_page_id === p.id && <Badge>Home</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {p.status === "published" && (
                    <a
                      href={`/${microsite.path_prefix}/${p.slug}`}
                      target="_blank"
                      rel="noreferrer"
                      data-testid={`link-view-page-${p.id}`}
                    >
                      <Button variant="ghost" size="icon">
                        <ExternalLink />
                      </Button>
                    </a>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={assignMutation.isPending && pendingId === p.id}
                    onClick={() => assignMutation.mutate({ pageId: p.id, micrositeId: null })}
                    data-testid={`button-unassign-page-${p.id}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-medium mb-2">Assign an existing page</h3>
        {availablePages.length === 0 ? (
          <p className="text-sm text-muted-foreground">All pages are already assigned.</p>
        ) : (
          <>
            <Input
              type="search"
              value={pageSearch}
              onChange={(e) => setPageSearch(e.target.value)}
              placeholder="Search pages by title or slug…"
              className="mb-2"
              data-testid="input-search-available-pages"
            />
            {filteredAvailablePages.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-available-page-matches">
                No pages match “{pageSearch.trim()}”.
              </p>
            ) : (
              <div className="space-y-2 max-h-[32rem] overflow-y-auto pr-1">
                {filteredAvailablePages.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2 flex-wrap rounded-md border p-3"
                    data-testid={`row-available-page-${p.id}`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{p.title || p.slug}</div>
                      <div className="text-sm text-muted-foreground">/{p.slug}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={assignMutation.isPending && pendingId === p.id}
                      onClick={() => assignMutation.mutate({ pageId: p.id, micrositeId: microsite.id })}
                      data-testid={`button-assign-page-${p.id}`}
                    >
                      Assign
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          Assigned pages stop being served at their bare slug on the default site and move under /{microsite.path_prefix}/.
        </p>
      </div>
    </div>
  );
}

const EMPTY_NAV_FORM = { title: "", url: "", location: "main_nav", link_type: "internal", is_active: true, parent_id: null };

function MicrositeNavTab({ microsite, micrositePages }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [navDialogOpen, setNavDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [navForm, setNavForm] = useState(EMPTY_NAV_FORM);
  const [expanded, setExpanded] = useState({});
  const [deleteNavTarget, setDeleteNavTarget] = useState(null);

  const { data: navItemsData, isLoading } = useQuery({
    queryKey: ["microsite-nav-items", microsite.id],
    queryFn: async () => {
      const items = await base44.entities.NavigationItem.filter({ microsite_id: microsite.id });
      return (items || []).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
  });
  const navItems = navItemsData || [];

  // Tree per location (children always share their parent's location, same as
  // the standard NavigationManagement page). Footer stays a flat list.
  const treesByLocation = useMemo(() => {
    const out = {};
    for (const loc of NAV_LOCATIONS) {
      out[loc.value] = buildNavTree(navItems, { location: loc.value });
    }
    return out;
  }, [navItems]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["microsite-nav-items", microsite.id] });
    queryClient.invalidateQueries({ queryKey: ["navigation-items"] });
  };

  const siblingsOf = (location, parentId) =>
    navItems
      .filter((i) => i.location === location && (i.parent_id || null) === (parentId || null))
      .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  const saveNavMutation = useMutation({
    mutationFn: async () => {
      const parentId = navForm.location === "footer" ? null : navForm.parent_id || null;
      const payload = {
        title: navForm.title,
        url: navForm.url,
        location: navForm.location,
        link_type: navForm.link_type,
        is_active: navForm.is_active,
        parent_id: parentId,
        microsite_id: microsite.id,
      };
      if (editingItem) {
        await base44.entities.NavigationItem.update(editingItem.id, payload);
        // Children must stay in the same bar as their parent, otherwise the
        // public header tree filter drops them (same rule as the standard
        // manager's moveToOtherBar).
        if (editingItem.location !== navForm.location) {
          const descendants = collectDescendants(navItems, editingItem.id);
          for (const d of descendants) {
            await base44.entities.NavigationItem.update(d.id, { location: navForm.location });
          }
        }
        return;
      }
      await base44.entities.NavigationItem.create({
        ...payload,
        display_order: siblingsOf(navForm.location, parentId).length,
      });
    },
    onSuccess: () => {
      invalidate();
      setNavDialogOpen(false);
      toast({ title: "Navigation item saved" });
    },
    onError: (e) => toast({ title: "Could not save item", description: e.message, variant: "destructive" }),
  });

  const deleteNavMutation = useMutation({
    mutationFn: async (item) => {
      // Delete the item together with all its descendants.
      const doomed = [item, ...collectDescendants(navItems, item.id)];
      for (const d of doomed.reverse()) {
        await base44.entities.NavigationItem.delete(d.id);
      }
    },
    onSuccess: () => {
      invalidate();
      setDeleteNavTarget(null);
      toast({ title: "Navigation item deleted" });
    },
    onError: (e) => toast({ title: "Could not delete item", description: e.message, variant: "destructive" }),
  });

  const moveMutation = useMutation({
    mutationFn: async ({ item, direction }) => {
      // Reorder within siblings (same location AND same parent), then
      // renumber the whole sibling group so duplicate display_order values
      // from legacy rows can't make the swap a no-op.
      const siblings = siblingsOf(item.location, item.parent_id);
      const idx = siblings.findIndex((i) => i.id === item.id);
      const newIdx = idx + direction;
      if (idx === -1 || newIdx < 0 || newIdx >= siblings.length) return;
      const reordered = [...siblings];
      const [moved] = reordered.splice(idx, 1);
      reordered.splice(newIdx, 0, moved);
      for (let i = 0; i < reordered.length; i++) {
        await base44.entities.NavigationItem.update(reordered[i].id, { display_order: i });
      }
    },
    onSuccess: () => invalidate(),
    onError: (e) => toast({ title: "Could not reorder", description: e.message, variant: "destructive" }),
  });

  const openCreateNav = (location = "main_nav", parentId = null) => {
    setEditingItem(null);
    setNavForm({ ...EMPTY_NAV_FORM, location, parent_id: parentId });
    setNavDialogOpen(true);
  };
  const openEditNav = (item) => {
    setEditingItem(item);
    setNavForm({
      title: item.title || "",
      url: item.url || "",
      location: item.location || "main_nav",
      link_type: item.link_type || "internal",
      is_active: item.is_active !== false,
      parent_id: item.parent_id || null,
    });
    setNavDialogOpen(true);
  };

  const toggleExpand = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  // Parent options for the dialog: same location, not footer, not the item
  // itself or anything inside its subtree, and shallow enough that the child
  // still fits within the 3 levels the public header renders.
  const parentOptions = useMemo(() => {
    if (navForm.location === "footer") return [];
    return navItems
      .filter((i) => {
        if (i.location !== navForm.location) return false;
        if (editingItem && isInSubtree(navItems, editingItem.id, i.id)) return false;
        return getItemDepth(navItems, i) < MAX_NAV_DEPTH;
      })
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }, [navItems, navForm.location, editingItem]);

  const renderTree = (items, level = 0) =>
    items.map((item, idx) => {
      const hasChildren = item.children && item.children.length > 0;
      const isExpanded = expanded[item.id] !== false; // expanded by default
      const canAddChild = item.location !== "footer" && level < MAX_NAV_DEPTH;
      return (
        <div key={item.id}>
          <div
            className="flex items-center justify-between gap-2 flex-wrap rounded-md border p-2.5"
            data-testid={`row-nav-item-${item.id}`}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {hasChildren ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => toggleExpand(item.id)}
                  aria-label={isExpanded ? "Collapse sub-items" : "Expand sub-items"}
                  data-testid={`button-expand-${item.id}`}
                >
                  {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </Button>
              ) : (
                <div className="w-9 shrink-0" />
              )}
              <div className="min-w-0">
                <span className="font-medium">{item.title}</span>
                <span className="text-sm text-muted-foreground ml-2 break-all">{item.url}</span>
                {item.is_active === false && <Badge variant="secondary" className="ml-2">Hidden</Badge>}
                {hasChildren && (
                  <Badge variant="outline" className="ml-2">
                    {item.children.length} sub-item{item.children.length > 1 ? "s" : ""}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {canAddChild && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="Add sub-item"
                  aria-label="Add sub-item"
                  onClick={() => openCreateNav(item.location, item.id)}
                  data-testid={`button-add-child-${item.id}`}
                >
                  <Plus />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                title="Move up"
                aria-label="Move up"
                disabled={idx === 0 || moveMutation.isPending}
                onClick={() => moveMutation.mutate({ item, direction: -1 })}
                data-testid={`button-move-up-${item.id}`}
              >
                <ChevronUp />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Move down"
                aria-label="Move down"
                disabled={idx === items.length - 1 || moveMutation.isPending}
                onClick={() => moveMutation.mutate({ item, direction: 1 })}
                data-testid={`button-move-down-${item.id}`}
              >
                <ChevronDown />
              </Button>
              <Button variant="ghost" size="icon" title="Edit" aria-label="Edit" onClick={() => openEditNav(item)} data-testid={`button-edit-nav-${item.id}`}>
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                title="Delete"
                aria-label="Delete"
                onClick={() => setDeleteNavTarget(item)}
                data-testid={`button-delete-nav-${item.id}`}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          {hasChildren && isExpanded && (
            <div className="ml-6 lg:ml-8 mt-1.5 space-y-1.5">
              {renderTree(item.children, level + 1)}
            </div>
          )}
        </div>
      );
    });

  const deleteDescendantsCount = deleteNavTarget
    ? collectDescendants(navItems, deleteNavTarget.id).length
    : 0;

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">
          These items replace the tenant navigation on microsite pages. Internal links to microsite pages
          should use the prefixed path, e.g. <code>/{microsite.path_prefix}/about</code>. Add sub-items to a
          menu item to create dropdown menus (up to 3 levels).
        </p>
        <Button onClick={() => openCreateNav()} data-testid="button-add-nav-item">
          <Plus className="w-4 h-4 mr-2" /> Add item
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : navItems.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-nav-items">No navigation items yet.</p>
      ) : (
        NAV_LOCATIONS.map(({ value, label }) => {
          const tree = treesByLocation[value] || [];
          if (tree.length === 0) return null;
          return (
            <div key={value}>
              <h4 className="text-sm font-medium mb-1.5">{label}</h4>
              <div className="space-y-1.5">{renderTree(tree)}</div>
            </div>
          );
        })
      )}

      <Dialog open={navDialogOpen} onOpenChange={setNavDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit navigation item" : "Add navigation item"}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => { e.preventDefault(); saveNavMutation.mutate(); }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="nav-title">Label</Label>
              <Input
                id="nav-title"
                value={navForm.title}
                onChange={(e) => setNavForm((f) => ({ ...f, title: e.target.value }))}
                required
                data-testid="input-nav-title"
              />
            </div>
            <div className="space-y-2">
              <Label>Link</Label>
              {micrositePages.length > 0 && (
                <Select
                  value="placeholder"
                  onValueChange={(v) => {
                    if (v !== "placeholder") {
                      setNavForm((f) => ({ ...f, url: `/${microsite.path_prefix}/${v}`, link_type: "internal" }));
                    }
                  }}
                >
                  <SelectTrigger data-testid="select-nav-page">
                    <SelectValue placeholder="Pick a microsite page…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="placeholder">Pick a microsite page…</SelectItem>
                    {micrositePages.map((p) => (
                      <SelectItem key={p.id} value={p.slug}>{p.title || p.slug}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                value={navForm.url}
                onChange={(e) => setNavForm((f) => ({ ...f, url: e.target.value }))}
                placeholder={`/${microsite.path_prefix}/about or https://…`}
                required
                data-testid="input-nav-url"
              />
            </div>
            <div className="space-y-2">
              <Label>Shows in</Label>
              <Select
                value={navForm.location}
                onValueChange={(v) => setNavForm((f) => ({ ...f, location: v, parent_id: null }))}
              >
                <SelectTrigger data-testid="select-nav-location">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NAV_LOCATIONS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {editingItem && editingItem.location !== navForm.location &&
                collectDescendants(navItems, editingItem.id).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Sub-items of this item will move with it.
                </p>
              )}
            </div>
            {navForm.location !== "footer" && (
              <div className="space-y-2">
                <Label>Parent item</Label>
                <Select
                  value={navForm.parent_id || "none"}
                  onValueChange={(v) => setNavForm((f) => ({ ...f, parent_id: v === "none" ? null : v }))}
                >
                  <SelectTrigger data-testid="select-nav-parent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None (top level)</SelectItem>
                    {parentOptions.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {getHierarchyPrefix(navItems, p.parent_id)}{p.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Items with a parent appear in a dropdown under that parent.
                </p>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Switch
                checked={navForm.is_active}
                onCheckedChange={(v) => setNavForm((f) => ({ ...f, is_active: v }))}
                data-testid="switch-nav-active"
              />
              <Label>Visible</Label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNavDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saveNavMutation.isPending} data-testid="button-save-nav-item">
                {saveNavMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteNavTarget} onOpenChange={(o) => !o && setDeleteNavTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete navigation item?</DialogTitle>
            <DialogDescription>
              {deleteNavTarget && deleteDescendantsCount > 0
                ? `"${deleteNavTarget.title}" and its ${deleteDescendantsCount} sub-item${deleteDescendantsCount > 1 ? "s" : ""} will be removed from this microsite's navigation.`
                : deleteNavTarget
                  ? `"${deleteNavTarget.title}" will be removed from this microsite's navigation.`
                  : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteNavTarget(null)} data-testid="button-cancel-delete-nav">
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteNavMutation.isPending}
              onClick={() => deleteNavMutation.mutate(deleteNavTarget)}
              data-testid="button-confirm-delete-nav"
            >
              {deleteNavMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MicrositeChromeTab({ microsite }) {
  // Task #2525: visual branding cards replaced the old raw-JSON textareas.
  return <MicrositeChromeEditor microsite={microsite} />;
}
