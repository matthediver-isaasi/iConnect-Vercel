import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { supabase } from "@/api/supabaseClient";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge as BadgeChip } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import BadgeImageLink from "@/components/badges/BadgeImageLink";
import { PaginationPageButton } from "@/components/ui/PaginationPageButton";
import { badgeListOptions, badgePageNumbers, BADGE_PAGE_SIZE } from "@/lib/badgeLibraryPagination";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2, Upload, Award, X } from "lucide-react";

/**
 * Badge Management (Task #3282): tenant-wide library of badges (image + name +
 * optional description + active flag) that future app extensions can reference.
 * Gated by the `admin.badges` RBAC key. Separate from role badge_image_url
 * (Role Management) and the about-me membership badge display.
 */

// Upload to Supabase Storage and return the public URL (same pattern as the
// role badge upload in RoleManagement.jsx).
async function uploadImageToSupabase(file, bucket, folderPrefix = "") {
  const fileExt = file.name.split(".").pop();
  const fileName = `${folderPrefix ? `${folderPrefix}/` : ""}${Date.now()}-${Math
    .random()
    .toString(36)
    .slice(2)}.${fileExt}`;

  const { error } = await supabase.storage.from(bucket).upload(fileName, file);
  if (error) throw error;

  const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return publicData.publicUrl;
}

const EMPTY_FORM = { name: "", description: "", image_url: "", is_active: true };

export default function BadgeManagement() {
  const queryClient = useQueryClient();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [isUploading, setIsUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState({ search: "", status: "all", page: 1 });

  useEffect(() => {
    const timer = setTimeout(() => {
      setListing((current) => current.search === search ? current : { ...current, search, page: 1 });
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("admin.badges")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ["badges", "library", listing],
    enabled: accessChecked,
    queryFn: async () => {
      const result = await base44.entities.Badge.list(badgeListOptions(listing));
      if (!Array.isArray(result?.data) || !Number.isInteger(result.count) || result.count < 0) {
        throw new Error("Invalid badge list response");
      }
      return result;
    },
  });
  const badges = data?.data ?? [];
  const total = data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / BADGE_PAGE_SIZE));
  const outOfRange = !!data && listing.page > pageCount;
  const hasFilters = !!listing.search || listing.status !== "all";

  useEffect(() => {
    if (!isFetching && !isError && outOfRange) {
      setListing((current) => ({ ...current, page: pageCount }));
    }
  }, [isFetching, isError, outOfRange, pageCount]);

  const clearSearch = () => {
    setSearch("");
    setListing((current) => ({ ...current, search: "", page: 1 }));
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["badges"] });

  const saveMutation = useMutation({
    mutationFn: async ({ id, payload }) => {
      if (id) return base44.entities.Badge.update(id, payload);
      return base44.entities.Badge.create(payload);
    },
    onSuccess: (_data, { id }) => {
      toast.success(id ? "Badge updated" : "Badge created");
      setDialogOpen(false);
      invalidate();
    },
    onError: (err) => toast.error(err?.message || "Failed to save badge"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Badge.delete(id),
    onSuccess: (result) => {
      toast.success(result?.outcome === "deactivated" ? "Badge deactivated" : "Badge deleted");
      setDeleteTarget(null);
      invalidate();
    },
    onError: (err) => toast.error(err?.message || "Failed to delete badge"),
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (badge) => {
    setEditingId(badge.id);
    setForm({
      name: badge.name || "",
      description: badge.description || "",
      image_url: badge.image_url || "",
      is_active: badge.is_active !== false,
    });
    setDialogOpen(true);
  };

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Badge image must be less than 5MB");
      return;
    }
    setIsUploading(true);
    try {
      const url = await uploadImageToSupabase(file, "images", "library-badges");
      setForm((f) => ({ ...f, image_url: url }));
      toast.success("Image uploaded");
    } catch (error) {
      console.error("Badge upload error:", error);
      toast.error("Failed to upload image");
    } finally {
      setIsUploading(false);
    }
    e.target.value = "";
  };

  const submitForm = (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Badge name is required");
      return;
    }
    if (!form.image_url) {
      toast.error("A badge image is required");
      return;
    }
    saveMutation.mutate({
      id: editingId,
      payload: {
        name: form.name.trim(),
        description: form.description.trim() || null,
        image_url: form.image_url,
        is_active: form.is_active,
      },
    });
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center py-24" data-testid="loading-access-check">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="px-4 lg:px-6 py-8 max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2" data-testid="text-badges-title">
            <Award className="w-6 h-6" />
            Badge Management
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage the library of badges available for use across the platform.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-create-badge">
          <Plus className="w-4 h-4 mr-2" />
          New Badge
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <div className="flex-1 space-y-2">
          <Label htmlFor="badge-search">Search badges</Label>
          <div className="flex gap-2">
            <Input id="badge-search" type="search" placeholder="Search by badge name"
              value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button variant="outline" onClick={clearSearch} disabled={!search} aria-label="Clear search">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="badge-status">Status</Label>
          <select id="badge-status" className="flex h-10 w-full sm:w-44 rounded-md border border-input bg-background px-3 text-sm"
            value={listing.status}
            onChange={(e) => setListing((current) => ({ ...current, status: e.target.value, page: 1 }))}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>

      {isError ? (
        <Card>
          <CardContent className="py-16 text-center space-y-3">
            <p role="alert">Unable to load badges. Please try again.</p>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>Retry</Button>
          </CardContent>
        </Card>
      ) : isLoading || outOfRange ? (
        <div className="flex items-center justify-center gap-2 py-24" role="status">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <span>Loading badges…</span>
        </div>
      ) : badges.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Award className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">{hasFilters ? "No matching badges" : "No badges yet"}</p>
            <p className="text-sm">{hasFilters ? "Try a different name or status." : "Create your first badge to start building the library."}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {badges.map((badge) => (
            <Card key={badge.id} data-testid={`card-badge-${badge.id}`}>
              <CardContent className="p-4 flex gap-4">
                <div className="w-16 h-16 rounded-lg border bg-muted/30 flex items-center justify-center overflow-hidden shrink-0">
                  {badge.image_url ? (
                    <img
                      src={badge.image_url}
                      alt={badge.name}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <Award className="w-6 h-6 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium truncate" data-testid={`text-badge-name-${badge.id}`}>
                      {badge.name}
                    </p>
                    <BadgeChip variant={badge.is_active !== false ? "default" : "secondary"}>
                      {badge.is_active !== false ? "Active" : "Inactive"}
                    </BadgeChip>
                  </div>
                  {badge.description && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                      {badge.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1 mt-2">
                    <BadgeImageLink badge={badge} />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(badge)}
                      data-testid={`button-edit-badge-${badge.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleteTarget(badge)}
                      data-testid={`button-delete-badge-${badge.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!isLoading && !isError && !outOfRange && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-6">
          <p className="text-sm text-muted-foreground" role="status">
            Showing {total ? (listing.page - 1) * BADGE_PAGE_SIZE + 1 : 0}–{Math.min(listing.page * BADGE_PAGE_SIZE, total)} of {total} badges
          </p>
          <nav aria-label="Badge pagination" className="flex flex-wrap justify-center gap-1">
            <Button variant="outline" size="sm" disabled={listing.page <= 1 || isFetching}
              onClick={() => setListing((current) => ({ ...current, page: current.page - 1 }))}>Previous</Button>
            {badgePageNumbers(listing.page, pageCount).map((page) => (
              <PaginationPageButton key={page} active={page === listing.page}
                aria-label={`Page ${page}`} aria-current={page === listing.page ? "page" : undefined}
                disabled={isFetching} onClick={() => setListing((current) => ({ ...current, page }))}>
                {page}
              </PaginationPageButton>
            ))}
            <Button variant="outline" size="sm" disabled={listing.page >= pageCount || isFetching}
              onClick={() => setListing((current) => ({ ...current, page: current.page + 1 }))}>Next</Button>
          </nav>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Badge" : "New Badge"}</DialogTitle>
            <DialogDescription>
              Upload a badge image and give it a name so it can be referenced elsewhere.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitForm} className="space-y-4">
            <div className="space-y-2">
              <Label>Badge Image *</Label>
              {form.image_url ? (
                <div className="flex items-center gap-3 p-3 border rounded-lg">
                  <img
                    src={form.image_url}
                    alt="Badge preview"
                    className="w-14 h-14 object-contain rounded"
                    data-testid="img-badge-preview"
                  />
                  <span className="text-sm text-muted-foreground truncate flex-1">
                    {form.image_url.split("/").pop()}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setForm((f) => ({ ...f, image_url: "" }))}
                    data-testid="button-remove-badge-image"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleUpload}
                    className="hidden"
                    id="library-badge-upload"
                    disabled={isUploading}
                  />
                  <label
                    htmlFor="library-badge-upload"
                    className={`flex items-center justify-center gap-2 p-6 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
                      isUploading ? "opacity-60 pointer-events-none" : "hover:border-primary/50"
                    }`}
                    data-testid="label-upload-badge-image"
                  >
                    {isUploading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    <span className="text-sm">
                      {isUploading ? "Uploading..." : "Upload badge image (max 5MB)"}
                    </span>
                  </label>
                </>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="badge-name">Name *</Label>
              <Input
                id="badge-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Founding Member"
                data-testid="input-badge-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="badge-description">Description</Label>
              <Textarea
                id="badge-description"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description of what this badge represents"
                rows={3}
                data-testid="input-badge-description"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="badge-active">Active</Label>
              <Switch
                id="badge-active"
                checked={form.is_active}
                onCheckedChange={(checked) => setForm((f) => ({ ...f, is_active: checked }))}
                data-testid="switch-badge-active"
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                data-testid="button-cancel-badge"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saveMutation.isPending || isUploading} data-testid="button-save-badge">
                {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {editingId ? "Save Changes" : "Create Badge"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete badge?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove "{deleteTarget?.name}" if it has no assignment or CPD
              history. Referenced badges will be preserved and marked inactive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-badge">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete-badge"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
