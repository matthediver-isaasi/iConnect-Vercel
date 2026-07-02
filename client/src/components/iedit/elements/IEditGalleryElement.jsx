import { useEffect, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { resolveFileUrl } from "@/lib/tenantUpload";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Image as ImageIcon, Lock, ChevronLeft, ChevronRight } from "lucide-react";
import { useScreenReader } from "@/contexts/ScreenReaderContext";

/**
 * Editor for the Gallery iEdit element.
 * content shape: { heading?: string, gallery_ids: string[], columns?: number }
 */
export function IEditGalleryElementEditor({ element, onChange }) {
  const content = element.content || {};
  const heading = content.heading || "";
  const selectedIds = Array.isArray(content.gallery_ids) ? content.gallery_ids : [];
  const columns = content.columns || 3;

  const { data: galleries = [], isLoading } = useQuery({
    queryKey: ["admin-galleries-for-widget"],
    queryFn: async () => {
      const list = await base44.entities.Gallery.list("-created_at");
      return Array.isArray(list) ? list : [];
    },
  });

  const update = (patch) => {
    onChange({ ...element, content: { ...content, ...patch } });
  };

  const toggleId = (id, checked) => {
    const set = new Set(selectedIds);
    if (checked) set.add(id);
    else set.delete(id);
    update({ gallery_ids: Array.from(set) });
  };

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="gallery-heading">Section Heading (optional)</Label>
        <Input
          id="gallery-heading"
          value={heading}
          onChange={(e) => update({ heading: e.target.value })}
          placeholder="e.g. Our Photo Galleries"
          data-testid="input-gallery-heading"
        />
      </div>

      <div>
        <Label htmlFor="gallery-columns">Columns</Label>
        <Input
          id="gallery-columns"
          type="number"
          min={1}
          max={6}
          value={columns}
          onChange={(e) => update({ columns: Math.max(1, Math.min(6, parseInt(e.target.value) || 3)) })}
          data-testid="input-gallery-columns"
        />
      </div>

      <div>
        <Label>Galleries to display</Label>
        <p className="text-xs text-slate-500 mb-2">
          Leave all unchecked to show every visible gallery automatically.
        </p>
        {isLoading ? (
          <p className="text-sm text-slate-500">Loading galleries…</p>
        ) : galleries.length === 0 ? (
          <p className="text-sm text-slate-500">
            No galleries yet. Create some on the Photo Galleries admin page.
          </p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto border rounded-md p-3">
            {galleries.map((g) => (
              <label
                key={g.id}
                className="flex items-start gap-2 cursor-pointer"
                data-testid={`label-gallery-${g.id}`}
              >
                <Checkbox
                  checked={selectedIds.includes(g.id)}
                  onCheckedChange={(checked) => toggleId(g.id, checked === true)}
                  data-testid={`checkbox-gallery-${g.id}`}
                />
                <span className="flex-1">
                  <span className="text-sm text-slate-900 font-medium">{g.title}</span>
                  {!g.is_public && (
                    <Badge variant="secondary" className="ml-2 text-xs">
                      Members-only
                    </Badge>
                  )}
                  {g.description && (
                    <span className="block text-xs text-slate-500 mt-0.5">{g.description}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Renderer for Gallery widget.
 * Guests see public galleries only (via publicClient).
 * Logged-in members see public + private (via base44 entity API).
 */
export function resolveAlt(photo, fallback, srOptimised) {
  const explicit = (photo?.alt_text || '').trim();
  if (explicit) return { alt: explicit, role: undefined };
  if (srOptimised) return { alt: '', role: 'presentation' };
  return { alt: fallback || '', role: undefined };
}

export function IEditGalleryElementRenderer({ element, memberInfo }) {
  const { optimised: srOptimised } = useScreenReader();
  const content = element?.content || {};
  const heading = content.heading;
  const selectedIds = Array.isArray(content.gallery_ids) ? content.gallery_ids : [];
  const columns = Math.max(1, Math.min(6, content.columns || 3));
  const isMember = !!memberInfo?.id;

  const { data: galleries = [], isLoading } = useQuery({
    queryKey: ["iedit-gallery-widget", isMember],
    queryFn: async () => {
      if (isMember) {
        const list = (await base44.entities.Gallery.list("display_order")) || [];
        const photoList = (await base44.entities.GalleryPhoto.list("display_order")) || [];
        const photosByGallery = new Map();
        for (const p of photoList) {
          if (!photosByGallery.has(p.gallery_id)) photosByGallery.set(p.gallery_id, []);
          photosByGallery.get(p.gallery_id).push(p);
        }
        return list.map((g) => ({ ...g, photos: photosByGallery.get(g.id) || [] }));
      }
      return await publicClient.listGalleries();
    },
  });

  const visible = useMemo(() => {
    let list = Array.isArray(galleries) ? galleries : [];
    if (selectedIds.length > 0) {
      list = list.filter((g) => selectedIds.includes(g.id));
    }
    return list;
  }, [galleries, selectedIds]);

  const [openGallery, setOpenGallery] = useState(null);
  const [activeIndex, setActiveIndex] = useState(0);

  if (isLoading) {
    return <div className="container mx-auto px-4 text-sm text-slate-500">Loading galleries…</div>;
  }

  if (visible.length === 0) {
    return null;
  }

  const gridCols = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
    5: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-5",
    6: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-6",
  }[columns];

  return (
    <div className="container mx-auto px-4">
      {heading && (
        <h2 className="text-2xl font-bold text-slate-900 mb-6" data-testid="text-gallery-heading">
          {heading}
        </h2>
      )}
      <div className={`grid ${gridCols} gap-4`}>
        {visible.map((g) => {
          const galleryPhotos = Array.isArray(g.photos) ? g.photos : [];
          // Prefer the cover resolved by the public list endpoint (cap-safe);
          // fall back to deriving it from the loaded photos for the member path.
          const cover =
            g.cover_photo ||
            galleryPhotos.find((p) => p.id === g.cover_photo_id) ||
            galleryPhotos[0] ||
            null;
          return (
            <Card
              key={g.id}
              className="overflow-hidden cursor-pointer hover-elevate"
              onClick={() => {
                setOpenGallery(g);
                setActiveIndex(0);
              }}
              data-testid={`card-gallery-${g.id}`}
            >
              <div className="relative aspect-[4/3] bg-slate-100 flex items-center justify-center">
                {cover ? (() => {
                  const { alt: coverAlt, role: coverRole } = resolveAlt(cover, g.title, srOptimised);
                  return (
                    <GalleryImage
                      photo={cover}
                      className="w-full h-full object-cover"
                      alt={coverAlt}
                      role={coverRole}
                    />
                  );
                })() : (
                  <ImageIcon className="w-12 h-12 text-slate-300" />
                )}
                {!g.is_public && (
                  <Badge
                    variant="secondary"
                    className="absolute top-2 right-2 flex items-center gap-1"
                  >
                    <Lock className="w-3 h-3" />
                    Members
                  </Badge>
                )}
              </div>
              <div className="p-4">
                <h3 className="font-semibold text-slate-900" data-testid={`text-gallery-title-${g.id}`}>
                  {g.title}
                </h3>
                {g.description && (
                  <p className="text-sm text-slate-600 mt-1 line-clamp-2">{g.description}</p>
                )}
                <p className="text-xs text-slate-500 mt-2">
                  {galleryPhotos.length} photo{galleryPhotos.length === 1 ? "" : "s"}
                </p>
              </div>
            </Card>
          );
        })}
      </div>

      {openGallery && (
        <Lightbox
          gallery={openGallery}
          activeIndex={activeIndex}
          onIndexChange={setActiveIndex}
          onClose={() => setOpenGallery(null)}
          srOptimised={srOptimised}
        />
      )}
    </div>
  );
}

export function GalleryImage({ photo, className, alt, role }) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resolved = await resolveFileUrl(photo.file_url);
        if (!cancelled) setSrc(resolved);
      } catch {
        if (!cancelled) setSrc(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photo.file_url]);

  if (!src) {
    return <div className={`${className} bg-slate-100`} />;
  }
  return <img src={src} alt={alt} role={role} className={className} loading="lazy" />;
}

export function Lightbox({ gallery, activeIndex, onIndexChange, onClose, srOptimised }) {
  const photos = gallery.photos || [];
  const photo = photos[activeIndex];

  // Arrow-key navigation. Escape is handled by the Dialog primitive itself,
  // which also traps focus and restores it to the opener on close.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "ArrowRight") onIndexChange((activeIndex + 1) % photos.length);
      if (e.key === "ArrowLeft") onIndexChange((activeIndex - 1 + photos.length) % photos.length);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIndex, photos.length, onIndexChange]);

  if (!photo) {
    return null;
  }

  const dialogTitle = gallery.title || "Photo gallery";
  const description = photos.length > 1
    ? `Photo ${activeIndex + 1} of ${photos.length}`
    : "Photo viewer";

  return (
    <Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="max-w-[95vw] w-[95vw] sm:max-w-4xl bg-black/95 border-none p-0 overflow-hidden"
        data-testid="lightbox-gallery"
      >
        <DialogHeader className="sr-only">
          <DialogTitle data-testid="text-lightbox-title">{dialogTitle}</DialogTitle>
          <DialogDescription data-testid="text-lightbox-description">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="relative flex flex-col items-center justify-center min-h-[60vh]">
          {photos.length > 1 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="absolute left-2 top-1/2 -translate-y-1/2 z-10 text-white hover:text-white"
                onClick={() =>
                  onIndexChange((activeIndex - 1 + photos.length) % photos.length)
                }
                aria-label="Previous photo"
                data-testid="button-prev-photo"
              >
                <ChevronLeft className="w-8 h-8" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 z-10 text-white hover:text-white"
                onClick={() =>
                  onIndexChange((activeIndex + 1) % photos.length)
                }
                aria-label="Next photo"
                data-testid="button-next-photo"
              >
                <ChevronRight className="w-8 h-8" />
              </Button>
            </>
          )}

          <div className="flex flex-col items-center px-8 py-6">
            {(() => {
              const { alt: photoAlt, role: photoRole } = resolveAlt(photo, gallery.title, srOptimised);
              return (
                <GalleryImage
                  photo={photo}
                  alt={photoAlt}
                  role={photoRole}
                  className="max-h-[75vh] max-w-full object-contain"
                />
              );
            })()}
            {(photo.caption || photo.alt_text) && (
              <p className="text-white text-center mt-3 px-4 text-sm">
                {photo.caption || photo.alt_text}
              </p>
            )}
            {photos.length > 1 && (
              <p
                className="text-white/70 text-xs mt-2"
                aria-live="polite"
                data-testid="text-lightbox-counter"
              >
                {activeIndex + 1} / {photos.length}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
