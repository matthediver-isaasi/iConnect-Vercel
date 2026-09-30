import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { publicClient } from "@/api/publicClient";
import { useLayoutContext } from "@/contexts/LayoutContext";
import { useScreenReader } from "@/contexts/ScreenReaderContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Image as ImageIcon, Lock, ChevronLeft, ChevronRight } from "lucide-react";
import {
  GalleryImage,
  Lightbox,
  resolveAlt,
} from "@/components/iedit/elements/IEditGalleryElement";

const PAGE_SIZE = 24;

export default function GalleryViewPage() {
  const { slug } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { authResolved } = useLayoutContext();
  const { optimised: srOptimised } = useScreenReader();

  const page = Math.max(1, parseInt(searchParams.get("page"), 10) || 1);

  const [openGallery, setOpenGallery] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // The gallery endpoint is authoritative for both anonymous and signed-in
  // viewers. In particular, do not infer access from a client-side entity
  // listing: audience rules are evaluated by the endpoint using the session.
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["gallery-by-slug", slug, page],
    enabled: authResolved && !!slug,
    placeholderData: (prev) => prev,
    queryFn: async () => {
      try {
        const result = await publicClient.getGallery(slug, page, PAGE_SIZE);
        if (!result) return { gallery: null, isLocked: false, totalPhotos: 0 };
        return {
          gallery: result,
          isLocked: !!result.is_locked,
          loginRedirectUrl: result.login_redirect_url || null,
          totalPhotos: Number.isFinite(result.total_photos)
            ? result.total_photos
            : (result.photos?.length || 0),
        };
      } catch {
        return { gallery: null, isLocked: false, totalPhotos: 0 };
      }
    },
  });

  const gallery = data?.gallery || null;
  const isLocked = data?.isLocked || false;
  const loginRedirectUrl = data?.loginRedirectUrl || null;
  const totalPhotos = data?.totalPhotos || 0;
  const totalPages = Math.max(1, Math.ceil(totalPhotos / PAGE_SIZE));

  const goToPage = (next) => {
    const target = Math.min(Math.max(1, next), totalPages);
    if (target === page) return;
    const params = new URLSearchParams(searchParams);
    if (target === 1) {
      params.delete("page");
    } else {
      params.set("page", String(target));
    }
    setSearchParams(params);
  };

  // Scroll back to the top whenever the visible page changes so the new photos
  // are in view rather than leaving the viewer scrolled to the old bottom.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [page]);

  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else if (page <= 3) {
      for (let i = 1; i <= 4; i++) pages.push(i);
      pages.push("...");
      pages.push(totalPages);
    } else if (page >= totalPages - 2) {
      pages.push(1);
      pages.push("...");
      for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      pages.push("...");
      for (let i = page - 1; i <= page + 1; i++) pages.push(i);
      pages.push("...");
      pages.push(totalPages);
    }
    return pages;
  };

  // Private gallery viewed by an anonymous visitor: send them to login and
  // return them here afterwards.
  useEffect(() => {
    if (isLocked && loginRedirectUrl) {
      window.location.href = loginRedirectUrl;
    }
  }, [isLocked, loginRedirectUrl]);

  useEffect(() => {
    if (gallery?.title) {
      document.title = gallery.title;
    }
    return () => {
      document.title = "Portal";
    };
  }, [gallery?.title]);

  const photos = useMemo(
    () => (Array.isArray(gallery?.photos) ? gallery.photos : []),
    [gallery]
  );

  if (!authResolved || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="animate-pulse text-slate-600" data-testid="text-gallery-loading">
          Loading…
        </div>
      </div>
    );
  }

  // Anonymous viewer of a private gallery — redirect is in flight.
  if (isLocked) {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="text-center">
          <Lock className="w-10 h-10 text-slate-400 mx-auto mb-3" />
          <p className="text-slate-600" data-testid="text-gallery-redirecting">
            This gallery is for members only. Redirecting you to log in…
          </p>
        </div>
      </div>
    );
  }

  if (!gallery) {
    return (
      <div className="min-h-screen p-4 md:p-8">
        <div className="max-w-4xl mx-auto text-center py-16">
          <h2 className="text-2xl font-bold text-slate-900 mb-4" data-testid="text-gallery-not-found">
            Gallery not found
          </h2>
          <p className="text-slate-600 mb-6">
            This gallery doesn't exist or is no longer available.
          </p>
          <Link to="/">
            <Button data-testid="button-gallery-home">Back to home</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold text-slate-900" data-testid="text-gallery-view-title">
          {gallery.title}
        </h1>
        {gallery.description && (
          <p className="text-slate-600 mt-2" data-testid="text-gallery-view-description">
            {gallery.description}
          </p>
        )}
        <p className="text-sm text-slate-500 mt-2" data-testid="text-gallery-photo-count">
          {totalPhotos} photo{totalPhotos === 1 ? "" : "s"}
        </p>

        {totalPhotos === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-20">
            <ImageIcon className="w-12 h-12 text-slate-300 mb-3" />
            <p className="text-slate-500" data-testid="text-gallery-empty">
              There are no photos in this gallery yet.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
            {photos.map((photo, index) => {
              const { alt, role } = resolveAlt(photo, gallery.title, srOptimised);
              return (
                <Card
                  key={photo.id}
                  className="overflow-hidden cursor-pointer hover-elevate"
                  onClick={() => {
                    setActiveIndex(index);
                    setOpenGallery(true);
                  }}
                  data-testid={`card-gallery-photo-${photo.id}`}
                >
                  <div className="relative aspect-[4/3] bg-slate-100 flex items-center justify-center">
                    <GalleryImage
                      photo={photo}
                      className="w-full h-full object-cover"
                      alt={alt}
                      role={role}
                    />
                  </div>
                  {(photo.caption || photo.alt_text) && (
                    <div className="p-3">
                      <p className="text-sm text-slate-600 line-clamp-2">
                        {photo.caption || photo.alt_text}
                      </p>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {totalPhotos > PAGE_SIZE && (
          <nav
            className="flex flex-wrap items-center justify-center gap-2 mt-8"
            aria-label="Gallery pages"
            data-testid="nav-gallery-pagination"
          >
            <Button
              variant="outline"
              size="icon"
              onClick={() => goToPage(page - 1)}
              disabled={page === 1 || isFetching}
              aria-label="Previous page"
              data-testid="button-gallery-prev-page"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>

            {getPageNumbers().map((p, idx) =>
              p === "..." ? (
                <span
                  key={`ellipsis-${idx}`}
                  className="px-2 text-slate-400"
                  aria-hidden="true"
                >
                  …
                </span>
              ) : (
                <Button
                  key={p}
                  variant={p === page ? "default" : "outline"}
                  size="icon"
                  onClick={() => goToPage(p)}
                  disabled={isFetching}
                  aria-label={`Page ${p}`}
                  aria-current={p === page ? "page" : undefined}
                  data-testid={`button-gallery-page-${p}`}
                >
                  {p}
                </Button>
              )
            )}

            <Button
              variant="outline"
              size="icon"
              onClick={() => goToPage(page + 1)}
              disabled={page === totalPages || isFetching}
              aria-label="Next page"
              data-testid="button-gallery-next-page"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </nav>
        )}
      </div>

      {openGallery && photos.length > 0 && (
        <Lightbox
          gallery={gallery}
          activeIndex={activeIndex}
          onIndexChange={setActiveIndex}
          onClose={() => setOpenGallery(false)}
          srOptimised={srOptimised}
        />
      )}
    </div>
  );
}
