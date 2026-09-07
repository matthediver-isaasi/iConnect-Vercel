import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Image as ImageIcon, Search } from "lucide-react";
import { publicClient } from "@/api/publicClient";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { GalleryImage, resolveAlt } from "@/components/iedit/elements/IEditGalleryElement";
import { useScreenReader } from "@/contexts/ScreenReaderContext";

export default function GalleryDirectory() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 12;
  const normalizedSearch = search.trim();
  const { optimised: srOptimised } = useScreenReader();
  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ["gallery-directory", normalizedSearch, page],
    queryFn: () => publicClient.listGalleryDirectory(search, page, pageSize),
    staleTime: 30_000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey?.[1] === normalizedSearch ? previousData : undefined,
  });
  const list = Array.isArray(data) ? data : data?.galleries || [];
  const total = Array.isArray(data) ? data.length : Number(data?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / (data?.pageSize || pageSize)));

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900" data-testid="text-gallery-directory-title">
            Photo Galleries
          </h1>
          <p className="text-slate-600 mt-2">
            Browse the galleries you are authorised to view.
          </p>
        </div>
        <div className="relative max-w-lg">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            className="pl-9"
            placeholder="Search galleries"
            aria-label="Search galleries"
            data-testid="input-search-gallery-directory"
          />
        </div>
        {!isLoading && !isError && total > 0 && (
          <p className="text-sm text-slate-500" aria-live="polite">
            {total} {total === 1 ? "gallery" : "galleries"}
            {isFetching ? " — updating…" : ""}
          </p>
        )}
        {isLoading ? (
          <p className="text-sm text-slate-500" data-testid="text-gallery-directory-loading">Loading galleries…</p>
        ) : isError ? (
          <p className="text-sm text-destructive" data-testid="text-gallery-directory-error">
            Unable to load galleries. Please try again.
          </p>
        ) : list.length === 0 ? (
          <Card className="p-10 text-center" data-testid="text-gallery-directory-empty">
            <ImageIcon className="w-10 h-10 text-slate-300 mx-auto mb-2" />
            <p className="text-slate-600">No galleries match your search.</p>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-busy={isFetching}>
              {list.map((gallery) => {
              const cover = gallery.cover_photo;
              const { alt, role } = resolveAlt(cover || {}, gallery.title, srOptimised);
              return (
                <Link key={gallery.id} to={`/gallery/${encodeURIComponent(gallery.slug)}`}>
                  <Card className="overflow-hidden h-full hover-elevate" data-testid={`card-gallery-directory-${gallery.id}`}>
                    <div className="aspect-[16/9] bg-slate-100 flex items-center justify-center">
                      {cover ? (
                        <GalleryImage photo={cover} className="h-full w-full object-cover" alt={alt} role={role} />
                      ) : (
                        <ImageIcon className="w-10 h-10 text-slate-300" aria-hidden="true" />
                      )}
                    </div>
                    <div className="p-4">
                      <h2 className="font-semibold text-slate-900">{gallery.title}</h2>
                      {gallery.description && <p className="mt-1 text-sm text-slate-600 line-clamp-2">{gallery.description}</p>}
                    </div>
                  </Card>
                </Link>
              );
              })}
            </div>
            {totalPages > 1 && (
              <nav className="mt-6 flex items-center justify-center gap-3" aria-label="Gallery directory pages">
                <Button
                  variant="outline"
                  disabled={page <= 1 || isFetching}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Previous
                </Button>
                <span className="text-sm text-slate-600">Page {page} of {totalPages}</span>
                <Button
                  variant="outline"
                  disabled={page >= totalPages || isFetching}
                  onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                >
                  Next
                </Button>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}