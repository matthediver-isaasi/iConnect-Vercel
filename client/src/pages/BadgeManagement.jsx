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

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("admin.badges")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: badges = [], isLoading } = useQuery({
    queryKey: ["badges"],
    enabled: accessChecked,
    queryFn: () => base44.entities.Badge.list("-created_date"),
  });

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
    onSuccess: () => {
      toast.success("Badge deleted");
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

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : badges.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <Award className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No badges yet</p>
            <p className="text-sm">Create your first badge to start building the library.</p>
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
                  <div className="flex gap-1 mt-2">
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
              This will permanently remove "{deleteTarget?.name}" from the badge library. This
              action cannot be undone.
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
