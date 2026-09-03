import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { uploadFileWithProgress, UPLOAD_TYPES, resolveFileUrl } from "@/lib/tenantUpload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus,
  Upload,
  Trash2,
  ImageIcon,
  Lock,
  Globe,
  Pencil,
  Star,
  ArrowLeft,
  GripVertical,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export default function PhotoGalleries() {
  const queryClient = useQueryClient();
  const [selectedGalleryId, setSelectedGalleryId] = useState(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [orderedGalleries, setOrderedGalleries] = useState([]);

  const galleriesQuery = useQuery({
    queryKey: ["admin-galleries"],
    queryFn: async () => {
      // Fetch sorted by display_order so DnD can persist relative ordering.
      const list = await base44.entities.Gallery.list("display_order");
      return Array.isArray(list) ? list : [];
    },
  });

  useEffect(() => {
    if (Array.isArray(galleriesQuery.data)) {
      setOrderedGalleries(galleriesQuery.data);
    }
  }, [galleriesQuery.data]);

  // Batch-resolve cover photos for the whole list so each admin card can show
  // a thumbnail without fetching photos gallery-by-gallery.
  const coverPhotoIds = useMemo(() => {
    const ids = (galleriesQuery.data || [])
      .map((g) => g.cover_photo_id)
      .filter(Boolean);
    return Array.from(new Set(ids));
  }, [galleriesQuery.data]);

  const coverUrlsQuery = useQuery({
    queryKey: ["admin-gallery-cover-urls", coverPhotoIds],
    enabled: coverPhotoIds.length > 0,
    queryFn: async () => {
      const photos = await base44.entities.GalleryPhoto.filter({
        id: coverPhotoIds,
      });
      const photoList = Array.isArray(photos) ? photos : [];
      const map = {};
      await Promise.all(
        photoList.map(async (p) => {
          try {
            const url = await resolveFileUrl(p.file_url);
            if (url) map[p.id] = url;
          } catch {
            /* leave unresolved so the card falls back to placeholder */
          }
        })
      );
      return map;
    },
  });
  const coverUrlByPhotoId = coverUrlsQuery.data || {};

  const selectedGallery =
    orderedGalleries.find((g) => g.id === selectedGalleryId) || null;

  const handleSaved = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
  };

  const deleteMutation = useMutation({
    mutationFn: async (id) => base44.entities.Gallery.delete(id),
    onSuccess: () => {
      toast.success("Gallery deleted");
      handleSaved();
      setConfirmDelete(null);
      if (selectedGalleryId === confirmDelete?.id) setSelectedGalleryId(null);
    },
    onError: (e) => toast.error(`Failed to delete gallery: ${e.message}`),
  });

  const reorderGalleryMutation = useMutation({
    mutationFn: async (newOrder) => {
      await Promise.all(
        newOrder.map((g, idx) => {
          if (g.display_order === idx) return Promise.resolve();
          return base44.entities.Gallery.update(g.id, { display_order: idx });
        })
      );
    },
    onSuccess: () => {
      toast.success("Order saved");
      queryClient.invalidateQueries({ queryKey: ["admin-galleries"] });
    },
    onError: (e) => toast.error(`Failed to save order: ${e.message}`),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleGalleryDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedGalleries.findIndex((g) => g.id === active.id);
    const newIndex = orderedGalleries.findIndex((g) => g.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(orderedGalleries, oldIndex, newIndex);
    setOrderedGalleries(reordered);
    reorderGalleryMutation.mutate(reordered);
  };

  const galleryIds = useMemo(
    () => orderedGalleries.map((g) => g.id),
    [orderedGalleries]
  );

  if (selectedGallery) {
    return (
      <GalleryDetail
        gallery={selectedGallery}
        onBack={() => setSelectedGalleryId(null)}
        onChanged={handleSaved}
      />
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">
            Photo Galleries
          </h1>
          <p className="text-sm text-slate-600">
            Organise photos into folders. Public galleries appear to all visitors;
            members-only galleries require login. Drag the grip handle to reorder.
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} data-testid="button-new-gallery">
          <Plus className="w-4 h-4 mr-2" />
          New Gallery
        </Button>
      </div>

      {galleriesQuery.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : orderedGalleries.length === 0 ? (
        <Card className="p-10 text-center">
          <ImageIcon className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-slate-600">No galleries yet. Create your first one.</p>
        </Card>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleGalleryDragEnd}
        >
          <SortableContext items={galleryIds} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {orderedGalleries.map((g) => (
                <SortableGalleryCard
                  key={g.id}
                  gallery={g}
                  coverUrl={
                    g.cover_photo_id
                      ? coverUrlByPhotoId[g.cover_photo_id]
                      : null
                  }
                  onOpen={() => setSelectedGalleryId(g.id)}
                  onEdit={() => setEditing(g)}
                  onDelete={() => setConfirmDelete(g)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <GalleryEditDialog
        open={isCreateOpen || editing !== null}
        gallery={editing}
        galleries={orderedGalleries}
        onClose={() => {
          setIsCreateOpen(false);
          setEditing(null);
        }}
        onSaved={handleSaved}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete gallery?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirmDelete?.title}" and all its photos will be permanently removed.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate(confirmDelete.id)}
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function slugifyHandle(value) {
  return (value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function GalleryEditDialog({ open, gallery, galleries = [], onClose, onSaved }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [accessPolicy, setAccessPolicy] = useState(null);

  useEffect(() => {
    if (open) {
      setTitle(gallery?.title || "");
      setDescription(gallery?.description || "");
      setIsPublic(gallery?.is_public ?? false);
      setSlug(gallery?.slug || "");
      setAccessPolicy(gallery?.access_policy?.version === 1 ? gallery.access_policy : null);
      // Existing galleries already have a slug, so treat it as user-set; new
      // galleries auto-suggest from the title until the user edits the handle.
      setSlugTouched(!!gallery?.slug);
    }
  }, [open, gallery]);

  const audienceOptionsQuery = useQuery({
    queryKey: ["gallery-audience-options"],
    enabled: open && !isPublic,
    staleTime: 60_000,
    queryFn: async () => {
        const [groups, events, complexEvents, roles] = await Promise.all([
        base44.entities.MemberGroup.list({ sort: { name: "asc" } }),
        base44.entities.Event.list({ sort: { start_date: "desc" } }),
          base44.entities.ComplexEvent.list({ sort: { start_date: "desc" } }),
        base44.entities.Role.list({ sort: { name: "asc" } }),
      ]);
      return {
        groups: Array.isArray(groups) ? groups : [],
          events: [
            ...(Array.isArray(events) ? events : []).map((event) => ({ ...event, event_type: "simple" })),
            ...(Array.isArray(complexEvents) ? complexEvents : []).map((event) => ({ ...event, event_type: "complex" })),
          ],
        roles: Array.isArray(roles) ? roles : [],
      };
    },
  });

  // Auto-suggest the handle from the title until the user edits it manually.
  useEffect(() => {
    if (open && !slugTouched) {
      setSlug(slugifyHandle(title));
    }
  }, [title, slugTouched, open]);

  const previousIsPublic = gallery?.is_public ?? false;
  const visibilityChanged = !!gallery?.id && previousIsPublic !== isPublic;

  const normalizedSlug = slugifyHandle(slug);
  const slugFormatInvalid = slug.length > 0 && normalizedSlug !== slug;
  const slugDuplicate =
    !!normalizedSlug &&
    galleries.some(
      (g) => g.id !== gallery?.id && (g.slug || "") === normalizedSlug
    );
  const slugError = !normalizedSlug
    ? "A URL handle is required."
    : slugFormatInvalid
    ? "Use only lowercase letters, numbers and hyphens."
    : slugDuplicate
    ? "This handle is already used by another gallery."
    : "";

  const shareUrl =
    typeof window !== "undefined" && normalizedSlug
      ? `${window.location.origin}/gallery/${normalizedSlug}`
      : "";

  const saveMutation = useMutation({
    mutationFn: async () => {
      // CREATE flow: simple
      if (!gallery?.id) {
        return base44.entities.Gallery.create({
          title,
          description: description || null,
          is_public: isPublic,
          access_policy: isPublic ? null : accessPolicy,
          slug: normalizedSlug,
          display_order: 0,
        });
      }

      // UPDATE flow: leak-safe ordering when visibility flips.
      // 1) First save title/description/slug without flipping is_public.
      await base44.entities.Gallery.update(gallery.id, {
        title,
        description: description || null,
        slug: normalizedSlug,
        // Do not clear a private gallery's policy before the server flips it
        // public; migrate-bucket clears it atomically with that transition.
        access_policy: visibilityChanged && isPublic
          ? gallery.access_policy
          : (isPublic ? null : accessPolicy),
      });

      if (!visibilityChanged) {
        return base44.entities.Gallery.get(gallery.id);
      }

      // The migration endpoint is the sole owner of the visibility transition.
      // It orders public->private moves before its flip and safely supports
      // retrying a partially-completed private->public move.
      setMigrating(true);
      let migrationData;
      try {
        const resp = await fetch("/api/galleries/migrate-bucket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            gallery_id: gallery.id,
            target_is_public: isPublic,
          }),
        });
        migrationData = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          throw new Error(migrationData.error || "Failed to migrate photos");
        }
      } finally {
        setMigrating(false);
      }

      if (migrationData.migrated > 0) {
        toast.success(
          `Moved ${migrationData.migrated} photo${
            migrationData.migrated === 1 ? "" : "s"
          } to ${isPublic ? "public" : "private"} storage`
        );
      }

      // Trust the server-owned transition, then reload the persisted gallery.
      return base44.entities.Gallery.get(gallery.id);
    },
    onSuccess: () => {
      toast.success(gallery?.id ? "Gallery updated" : "Gallery created");
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const isBusy = saveMutation.isPending || migrating;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !isBusy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{gallery?.id ? "Edit Gallery" : "New Gallery"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="g-title">Title</Label>
            <Input
              id="g-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Annual Conference 2026"
              data-testid="input-gallery-title"
            />
          </div>
          <div>
            <Label htmlFor="g-desc">Description (optional)</Label>
            <Textarea
              id="g-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="input-gallery-description"
            />
          </div>
          <div>
            <Label htmlFor="g-slug">URL handle</Label>
            <Input
              id="g-slug"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              onBlur={() => setSlug((s) => slugifyHandle(s))}
              placeholder="e.g. annual-conference-2026"
              data-testid="input-gallery-slug"
            />
            {slugError ? (
              <p className="text-xs text-destructive mt-1" data-testid="text-gallery-slug-error">
                {slugError}
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                Shareable link:{" "}
                <span className="break-all text-slate-700" data-testid="text-gallery-share-url">
                  {shareUrl}
                </span>{" "}
                <span className="text-slate-500">
                  ({isPublic ? "public — no login required" : "members-only — login required"})
                </span>
              </p>
            )}
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="g-public"
              checked={isPublic}
              onCheckedChange={(c) => setIsPublic(c === true)}
              data-testid="checkbox-gallery-public"
            />
            <div>
              <Label htmlFor="g-public" className="cursor-pointer">
                Public gallery
              </Label>
              <p className="text-xs text-slate-500">
                Public galleries are visible to anonymous visitors. Members-only
                galleries require login.
                {visibilityChanged && (
                  <span className="block mt-1 text-warning">
                    Existing photos will be moved to the{" "}
                    {isPublic ? "public" : "private"} storage bucket on save.
                  </span>
                )}
              </p>
            </div>
          </div>
          {!isPublic && (
            <GalleryAudienceEditor
              value={accessPolicy}
              onChange={setAccessPolicy}
              options={audienceOptionsQuery.data}
              loading={audienceOptionsQuery.isLoading}
            />
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isBusy}
            data-testid="button-cancel-gallery"
          >
            Cancel
          </Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={!title.trim() || !!slugError || isBusy}
            data-testid="button-save-gallery"
          >
            {migrating ? "Moving photos…" : saveMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Each rule group is OR-ed with every other group; conditions inside a group
// are AND-ed. IDs only are persisted, so the server remains the authority for
// both tenant scoping and membership/event/role matching.
function GalleryAudienceEditor({ value, onChange, options, loading }) {
  const groups = Array.isArray(value?.groups) && value.groups.length ? value.groups : [{ conditions: [] }];
  const setGroups = (nextGroups) => onChange(nextGroups.some((group) => group.conditions?.length)
    ? { version: 1, groups: nextGroups.filter((group) => group.conditions?.length) }
    : null);
  const [searches, setSearches] = useState({});
  const optionSets = {
    member_group: options?.groups || [],
    event: options?.events || [],
    role: options?.roles || [],
  };
  const labelFor = (condition) => {
    const found = optionSets[condition.type]?.find((item) => item.id === condition.id);
    return found?.name || found?.title || found?.event_name || condition.id;
  };
  const updateGroup = (index, next) => setGroups(groups.map((group, i) => i === index ? next : group));
  const addCondition = (index, type) => {
    const first = optionSets[type][0];
    if (!first) return;
    updateGroup(index, {
      ...groups[index],
      conditions: [...(groups[index].conditions || []), type === "event"
        ? { type, event_type: first.event_type, id: first.id }
        : { type, id: first.id }],
    });
  };
  const searchableOptions = (type, groupIndex) => {
    const search = (searches[groupIndex] || "").trim().toLowerCase();
    return optionSets[type].filter((item) => !search || String(item.name || item.title || item.event_name || "").toLowerCase().includes(search));
  };

  return (
    <div className="rounded-md border p-3 space-y-3" data-testid="gallery-audience-editor">
      <div>
        <Label>Members-only audience</Label>
        <p className="text-xs text-slate-500 mt-1">
          A member can view this gallery when they match every condition in any one group.
          Groups are joined by OR; conditions in each group are joined by AND.
        </p>
      </div>
      {groups.map((ruleGroup, groupIndex) => (
        <div key={groupIndex} className="rounded border bg-slate-50 p-3 space-y-2" data-testid={`gallery-audience-group-${groupIndex}`}>
          <div className="flex justify-between items-center">
            <span className="text-sm font-medium">{groupIndex ? "OR audience group" : "Audience group"}</span>
            {groups.length > 1 && (
              <Button type="button" variant="ghost" size="icon" onClick={() => setGroups(groups.filter((_, i) => i !== groupIndex))} aria-label="Remove audience group">
                <X className="w-4 h-4" />
              </Button>
            )}
          </div>
          <Input
            value={searches[groupIndex] || ""}
            onChange={(event) => setSearches((current) => ({ ...current, [groupIndex]: event.target.value }))}
            placeholder="Search tenant groups, events, or roles"
            aria-label="Search audience options"
            className="h-8 text-sm"
            data-testid={`input-gallery-audience-search-${groupIndex}`}
          />
          {(ruleGroup.conditions || []).map((condition, conditionIndex) => (
            <div key={conditionIndex} className="flex gap-2 items-center">
              <span className="text-xs text-slate-500 w-8">{conditionIndex ? "AND" : ""}</span>
              <select
                className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={`${condition.type}:${condition.id}`}
                onChange={(event) => {
                  const [type, id] = event.target.value.split(":");
                  updateGroup(groupIndex, {
                    ...ruleGroup,
                    conditions: ruleGroup.conditions.map((item, i) => i === conditionIndex
                      ? (type === "event" ? { type, event_type: optionSets.event.find((item) => item.id === id)?.event_type, id } : { type, id })
                      : item),
                  });
                }}
                aria-label={`Audience condition ${conditionIndex + 1}`}
              >
                <option value={`${condition.type}:${condition.id}`}>{`${condition.type.replace("_", " ")}: ${labelFor(condition)}`}</option>
                {Object.entries(optionSets).flatMap(([type]) => searchableOptions(type, groupIndex).map((item) => (
                  <option key={`${type}:${item.id}`} value={`${type}:${item.id}`}>{`${type.replace("_", " ")}: ${item.name || item.title || item.event_name}`}</option>
                )))}
              </select>
              <Button type="button" variant="ghost" size="icon" onClick={() => updateGroup(groupIndex, { ...ruleGroup, conditions: ruleGroup.conditions.filter((_, i) => i !== conditionIndex) })} aria-label="Remove audience condition">
                <X className="w-4 h-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2 flex-wrap">
            {["member_group", "event", "role"].map((type) => (
              <Button key={type} type="button" variant="outline" size="sm" disabled={loading || optionSets[type].length === 0} onClick={() => addCondition(groupIndex, type)}>
                <Plus className="mr-1 w-3 h-3" /> Add {type === "member_group" ? "group" : type}
              </Button>
            ))}
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => setGroups([...groups, { conditions: [] }])} data-testid="button-add-gallery-audience-group">
        <Plus className="mr-1 w-3 h-3" /> Add OR group
      </Button>
    </div>
  );
}

function SortableGalleryCard({ gallery, coverUrl, onOpen, onEdit, onDelete }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: gallery.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : "auto",
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className="p-4 hover-elevate cursor-pointer"
      onClick={onOpen}
      data-testid={`card-admin-gallery-${gallery.id}`}
    >
      <div className="relative aspect-[16/9] bg-slate-100 rounded-md overflow-hidden mb-3">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            data-testid={`img-admin-gallery-cover-${gallery.id}`}
          />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center"
            data-testid={`img-admin-gallery-cover-${gallery.id}`}
          >
            <ImageIcon className="w-8 h-8 text-slate-300" />
          </div>
        )}
      </div>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <button
            {...attributes}
            {...listeners}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            className="p-1 rounded hover-elevate cursor-grab active:cursor-grabbing shrink-0"
            aria-label="Drag to reorder gallery"
            data-testid={`drag-handle-gallery-${gallery.id}`}
          >
            <GripVertical className="w-4 h-4 text-slate-500" />
          </button>
          <h3
            className="font-semibold text-slate-900 truncate"
            data-testid={`text-admin-gallery-${gallery.id}`}
          >
            {gallery.title}
          </h3>
        </div>
        <Badge
          variant={gallery.is_public ? "default" : "secondary"}
          className="flex items-center gap-1 shrink-0"
        >
          {gallery.is_public ? <Globe className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
          {gallery.is_public ? "Public" : "Members"}
        </Badge>
      </div>
      {gallery.description && (
        <p className="text-sm text-slate-600 line-clamp-2 mb-3">{gallery.description}</p>
      )}
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          data-testid={`button-edit-gallery-${gallery.id}`}
        >
          <Pencil className="w-3 h-3 mr-1" />
          Edit
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          data-testid={`button-delete-gallery-${gallery.id}`}
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      </div>
    </Card>
  );
}

function GalleryDetail({ gallery, onBack, onChanged }) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef(null);
  const dropRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);
  const [editingPhoto, setEditingPhoto] = useState(null);

  // Local working copy of photos so DnD reorder feels instant. We sync from
  // the server query whenever it returns a new list.
  const [orderedPhotos, setOrderedPhotos] = useState([]);

  const maxUploadMbQuery = useQuery({
    queryKey: ["system-setting", "photo_gallery_max_upload_mb"],
    queryFn: async () => {
      try {
        const list = await base44.entities.SystemSettings.filter({
          setting_key: "photo_gallery_max_upload_mb",
        });
        const setting = Array.isArray(list) && list.length > 0 ? list[0] : null;
        const num = setting ? Number(setting.setting_value) : NaN;
        return Number.isFinite(num) && num > 0 ? num : 5;
      } catch {
        return 5;
      }
    },
  });
  const maxUploadMb = maxUploadMbQuery.data ?? 5;

  const photosQuery = useQuery({
    queryKey: ["admin-gallery-photos", gallery.id],
    queryFn: async () => {
      const list = await base44.entities.GalleryPhoto.filter(
        { gallery_id: gallery.id },
        "display_order"
      );
      return Array.isArray(list) ? list : [];
    },
  });

  useEffect(() => {
    if (Array.isArray(photosQuery.data)) {
      setOrderedPhotos(photosQuery.data);
    }
  }, [photosQuery.data]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", gallery.id] });
    onChanged();
  };

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    const limitBytes = maxUploadMb * 1024 * 1024;
    const oversized = files.filter((f) => f.size > limitBytes);
    const validFiles = files.filter((f) => f.size <= limitBytes);
    if (oversized.length > 0) {
      const names = oversized.map((f) => f.name).join(", ");
      toast.error(
        `${oversized.length} file${oversized.length === 1 ? "" : "s"} exceed the ${maxUploadMb}MB upload limit: ${names}`
      );
    }
    if (validFiles.length === 0) return;
    setUploading(true);
    let success = 0;
    const failures = [];
    for (let i = 0; i < validFiles.length; i++) {
      const file = validFiles[i];
      try {
        setUploadProgress(0);
        const result = await uploadFileWithProgress(file, {
          type: UPLOAD_TYPES.GALLERY_PHOTO,
          entityId: gallery.id,
          isPrivate: !gallery.is_public,
          maxSizeBytes: limitBytes,
          onProgress: setUploadProgress,
        });
        await base44.entities.GalleryPhoto.create({
          gallery_id: gallery.id,
          storage_path: result.storage_path,
          bucket: result.bucket,
          file_url: result.file_url,
          caption: null,
          alt_text: file.name,
          display_order: orderedPhotos.length + i,
        });
        success += 1;
      } catch (e) {
        console.error("Upload failed", e);
        failures.push({ name: file.name, message: e?.message || "Upload failed" });
      }
    }
    setUploading(false);
    setUploadProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (success > 0) toast.success(`Uploaded ${success} photo${success === 1 ? "" : "s"}`);
    for (const f of failures) {
      toast.error(`${f.name}: ${f.message}`);
    }
    refresh();
  };

  // Drag-and-drop file upload handlers
  useEffect(() => {
    const node = dropRef.current;
    if (!node) return;
    const onOver = (e) => {
      e.preventDefault();
      setIsDragOver(true);
    };
    const onLeave = () => setIsDragOver(false);
    const onDrop = (e) => {
      e.preventDefault();
      setIsDragOver(false);
      if (e.dataTransfer?.files?.length) {
        handleFiles(e.dataTransfer.files);
      }
    };
    node.addEventListener("dragover", onOver);
    node.addEventListener("dragleave", onLeave);
    node.addEventListener("drop", onDrop);
    return () => {
      node.removeEventListener("dragover", onOver);
      node.removeEventListener("dragleave", onLeave);
      node.removeEventListener("drop", onDrop);
    };
  });

  const deletePhotoMutation = useMutation({
    mutationFn: async (id) => base44.entities.GalleryPhoto.delete(id),
    onSuccess: () => {
      toast.success("Photo removed");
      refresh();
    },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const setCoverMutation = useMutation({
    mutationFn: async (photoId) =>
      base44.entities.Gallery.update(gallery.id, { cover_photo_id: photoId }),
    onSuccess: () => {
      toast.success("Cover updated");
      refresh();
    },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const updatePhotoMutation = useMutation({
    mutationFn: async ({ id, patch }) =>
      base44.entities.GalleryPhoto.update(id, patch),
    onSuccess: () => {
      toast.success("Photo updated");
      refresh();
      setEditingPhoto(null);
    },
    onError: (e) => toast.error(`Failed: ${e.message}`),
  });

  const reorderMutation = useMutation({
    mutationFn: async (newOrder) => {
      // Persist display_order for any photos whose position changed
      await Promise.all(
        newOrder.map((p, idx) => {
          if (p.display_order === idx) return Promise.resolve();
          return base44.entities.GalleryPhoto.update(p.id, { display_order: idx });
        })
      );
    },
    onSuccess: () => {
      toast.success("Order saved");
      queryClient.invalidateQueries({ queryKey: ["admin-gallery-photos", gallery.id] });
    },
    onError: (e) => toast.error(`Failed to save order: ${e.message}`),
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedPhotos.findIndex((p) => p.id === active.id);
    const newIndex = orderedPhotos.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(orderedPhotos, oldIndex, newIndex);
    setOrderedPhotos(reordered);
    reorderMutation.mutate(reordered);
  };

  const photoIds = useMemo(() => orderedPhotos.map((p) => p.id), [orderedPhotos]);

  return (
    <div className="container mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onBack} data-testid="button-back-galleries">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{gallery.title}</h1>
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Badge
              variant={gallery.is_public ? "default" : "secondary"}
              className="flex items-center gap-1"
            >
              {gallery.is_public ? <Globe className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
              {gallery.is_public ? "Public" : "Members-only"}
            </Badge>
            <span>
              {orderedPhotos.length} photo{orderedPhotos.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </div>

      <Card
        ref={dropRef}
        className={`p-4 border-2 border-dashed transition-colors ${
          isDragOver ? "border-blue-400 bg-blue-50" : "border-slate-200"
        }`}
        data-testid="dropzone-upload"
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="font-semibold text-slate-900">Upload Photos</h2>
            <p className="text-xs text-slate-500">
              Drag &amp; drop image files here or click to browse. Max{" "}
              {maxUploadMb}MB each.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
              data-testid="input-file-upload"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              data-testid="button-upload-photos"
            >
              <Upload className="w-4 h-4 mr-2" />
              {uploading ? `Uploading ${uploadProgress}%` : "Upload Photos"}
            </Button>
          </div>
        </div>
      </Card>

      {photosQuery.isLoading ? (
        <p className="text-sm text-slate-500">Loading photos…</p>
      ) : orderedPhotos.length === 0 ? (
        <Card className="p-10 text-center">
          <ImageIcon className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-slate-600">No photos yet. Upload some above.</p>
        </Card>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={photoIds} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {orderedPhotos.map((p) => (
                <SortablePhotoTile
                  key={p.id}
                  photo={p}
                  isCover={gallery.cover_photo_id === p.id}
                  onSetCover={() => setCoverMutation.mutate(p.id)}
                  onDelete={() => deletePhotoMutation.mutate(p.id)}
                  onEdit={() => setEditingPhoto(p)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <PhotoEditDialog
        photo={editingPhoto}
        onClose={() => setEditingPhoto(null)}
        onSave={(patch) =>
          updatePhotoMutation.mutate({ id: editingPhoto.id, patch })
        }
        saving={updatePhotoMutation.isPending}
      />
    </div>
  );
}

function SortablePhotoTile({ photo, isCover, onSetCover, onDelete, onEdit }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: photo.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : "auto",
  };

  const [src, setSrc] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const url = await resolveFileUrl(photo.file_url);
        if (!cancelled) setSrc(url);
      } catch {
        if (!cancelled) setSrc(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo.file_url]);

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className="overflow-hidden"
      data-testid={`tile-photo-${photo.id}`}
    >
      <div className="relative aspect-square bg-slate-100">
        {src ? (
          <img
            src={src}
            alt={photo.alt_text || ""}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ImageIcon className="w-8 h-8 text-slate-300" />
          </div>
        )}
        {isCover && (
          <Badge className="absolute top-2 left-2 flex items-center gap-1">
            <Star className="w-3 h-3" />
            Cover
          </Badge>
        )}
        <button
          {...attributes}
          {...listeners}
          className="absolute top-2 right-2 bg-white/90 rounded p-1 cursor-grab active:cursor-grabbing"
          aria-label="Drag to reorder"
          data-testid={`drag-handle-photo-${photo.id}`}
          onClick={(e) => e.preventDefault()}
        >
          <GripVertical className="w-4 h-4 text-slate-600" />
        </button>
      </div>
      {(photo.caption || photo.alt_text) && (
        <div className="px-2 pt-2 text-xs text-slate-600 line-clamp-2">
          {photo.caption || photo.alt_text}
        </div>
      )}
      <div className="p-2 flex items-center justify-end gap-1 flex-wrap">
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          data-testid={`button-edit-photo-${photo.id}`}
        >
          <Pencil className="w-3 h-3 mr-1" />
          Edit
        </Button>
        {!isCover && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSetCover}
            data-testid={`button-set-cover-${photo.id}`}
          >
            <Star className="w-3 h-3 mr-1" />
            Cover
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          data-testid={`button-delete-photo-${photo.id}`}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
}

function PhotoEditDialog({ photo, onClose, onSave, saving }) {
  const [caption, setCaption] = useState("");
  const [altText, setAltText] = useState("");

  useEffect(() => {
    if (photo) {
      setCaption(photo.caption || "");
      setAltText(photo.alt_text || "");
    }
  }, [photo]);

  return (
    <Dialog open={!!photo} onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Photo</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="p-caption">Caption</Label>
            <Textarea
              id="p-caption"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              rows={2}
              placeholder="Shown under the photo in the lightbox"
              data-testid="input-photo-caption"
            />
          </div>
          <div>
            <Label htmlFor="p-alt">Alt Text</Label>
            <Input
              id="p-alt"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              placeholder="Describe the photo for screen readers"
              data-testid="input-photo-alt"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={saving}
            data-testid="button-cancel-photo-edit"
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSave({
                caption: caption.trim() || null,
                alt_text: altText.trim() || null,
              })
            }
            disabled={saving}
            data-testid="button-save-photo-edit"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
