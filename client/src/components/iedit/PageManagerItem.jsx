import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import {
  Pencil,
  Trash2,
  ExternalLink,
  Zap,
  Copy,
  Home,
  Pin,
  PinOff,
  GripVertical,
} from "lucide-react";

/**
 * A single page in the page manager. Renders as a grid card (viewMode='grid')
 * or a compact list row (viewMode='list'). Draggable by its grip handle so it
 * can be dropped onto a folder in the sidebar.
 */
export default function PageManagerItem({
  page,
  viewMode,
  homePageSlug,
  getStatusBadge,
  onEdit,
  onOpenPublic,
  onRename,
  onDuplicate,
  onDelete,
  onTogglePublish,
  onToggleHome,
  onTogglePin,
  duplicatePending,
  publishPending,
  homePending,
  pinPending,
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: `page:${page.id}` });

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  const isPinned = !!page.pinned_at;
  const isHome = homePageSlug === page.slug;
  const isLogin = page.slug === "login";

  const dragHandle = (
    <button
      type="button"
      {...listeners}
      {...attributes}
      className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 touch-none"
      title="Drag to a folder"
      data-testid={`drag-handle-${page.id}`}
    >
      <GripVertical className="w-4 h-4" />
    </button>
  );

  const pinButton = (
    <Button
      variant="outline"
      size="icon"
      onClick={() => onTogglePin(page)}
      disabled={pinPending}
      title={isPinned ? "Unpin" : "Pin to top"}
      className={isPinned ? "text-blue-600" : ""}
      data-testid={`button-toggle-pin-${page.id}`}
    >
      {isPinned ? <PinOff className="w-3 h-3" /> : <Pin className="w-3 h-3" />}
    </Button>
  );

  if (viewMode === "list") {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 hover-elevate"
        data-testid={`row-page-${page.id}`}
      >
        {dragHandle}
        {isPinned && (
          <Pin className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-900 truncate" data-testid={`text-page-title-${page.id}`}>
              {page.title}
            </span>
            {isHome && (
              <Badge className="bg-blue-100 text-blue-700 border-blue-300">
                <Home className="w-3 h-3 mr-1" />
                Home
              </Badge>
            )}
          </div>
          <span className="font-mono text-xs text-slate-500">/{page.slug}</span>
        </div>
        <Badge className={`${getStatusBadge(page.status)} flex-shrink-0`}>
          {page.status}
        </Badge>
        <Badge variant="outline" className="flex-shrink-0 hidden md:inline-flex">
          {page.layout_type === "member"
            ? "Portal"
            : page.layout_type === "hybrid"
            ? "Hybrid"
            : "Public"}
        </Badge>
        <Badge variant="outline" className="flex-shrink-0 hidden md:inline-flex">
          {page.builder_type === "canvas" ? "Canvas" : "iEdit"}
        </Badge>
        <span className="text-xs text-slate-500 flex-shrink-0 hidden lg:inline w-28 text-right">
          {page.updated_date
            ? format(new Date(page.updated_date), "MMM d, yyyy")
            : "—"}
        </span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {pinButton}
          <Button
            variant="outline"
            size="icon"
            onClick={() => onEdit(page)}
            title="Edit"
            data-testid={`button-edit-page-${page.id}`}
          >
            <Pencil className="w-3 h-3" />
          </Button>
          {page.status === "published" && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => onOpenPublic(page)}
              title="View published page"
            >
              <ExternalLink className="w-3 h-3" />
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={() => onTogglePublish(page)}
            disabled={publishPending}
            title={page.status === "published" ? "Unpublish" : "Publish"}
            className={
              page.status === "published" ? "text-warning" : "text-green-600"
            }
            data-testid={`button-toggle-publish-${page.id}`}
          >
            <Zap className="w-3 h-3" />
          </Button>
          {!isLogin && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => onDuplicate(page)}
              disabled={duplicatePending}
              title="Duplicate"
              data-testid={`button-duplicate-page-${page.id}`}
            >
              <Copy className="w-3 h-3" />
            </Button>
          )}
          {!isLogin && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => onDelete(page)}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              title="Delete"
              data-testid={`button-delete-page-${page.id}`}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Grid / card view
  return (
    <Card
      ref={setNodeRef}
      style={style}
      className="border-slate-200 hover:shadow-lg transition-shadow"
      data-testid={`card-page-${page.id}`}
    >
      <CardHeader>
        <div className="flex items-start justify-between mb-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {dragHandle}
            {isPinned && (
              <Pin className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
            )}
            <CardTitle className="text-lg truncate" data-testid={`text-page-title-${page.id}`}>
              {page.title}
            </CardTitle>
            {isHome && (
              <Badge className="bg-blue-100 text-blue-700 border-blue-300">
                <Home className="w-3 h-3 mr-1" />
                Home
              </Badge>
            )}
          </div>
          <Badge className={getStatusBadge(page.status)}>{page.status}</Badge>
        </div>
        {page.description && (
          <p className="text-sm text-slate-600 line-clamp-2">
            {page.description}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-sm">
          <span className="text-slate-500">Slug:</span>
          <span className="ml-2 font-mono text-slate-700">/{page.slug}</span>
        </div>

        <div className="text-sm">
          <span className="text-slate-500">View:</span>
          <Badge variant="outline" className="ml-2">
            {page.layout_type === "public" && "Public"}
            {page.layout_type === "member" && "Portal"}
            {page.layout_type === "hybrid" && "Hybrid"}
            {!["public", "member", "hybrid"].includes(page.layout_type) &&
              (page.layout_type || "Public")}
          </Badge>
        </div>

        <div className="text-sm">
          <span className="text-slate-500">Builder:</span>
          <Badge
            variant="outline"
            className="ml-2"
            data-testid={`badge-builder-type-${page.id}`}
          >
            {page.builder_type === "canvas" ? "Canvas" : "iEdit"}
          </Badge>
        </div>

        {page.updated_date && (
          <div className="text-xs text-slate-500">
            Updated {format(new Date(page.updated_date), "MMM d, yyyy")}
          </div>
        )}

        <div className="flex gap-2 pt-2 border-t border-slate-200 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(page)}
            className="flex-1"
            data-testid={`button-edit-page-${page.id}`}
          >
            <Pencil className="w-3 h-3 mr-1" />
            Edit
          </Button>
          {pinButton}
          {page.status === "published" && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => onOpenPublic(page)}
              title="View Published Page"
            >
              <ExternalLink className="w-3 h-3" />
            </Button>
          )}
          {page.builder_type === "canvas" && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => onRename(page)}
              title={
                isLogin
                  ? "System page — name and slug are locked"
                  : "Rename / change slug"
              }
              data-testid={`button-rename-page-${page.id}`}
            >
              <Pencil className="w-3 h-3" />
            </Button>
          )}
          {!isLogin && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => onDuplicate(page)}
              disabled={duplicatePending}
              title="Duplicate Page"
              data-testid={`button-duplicate-page-${page.id}`}
            >
              <Copy className="w-3 h-3" />
            </Button>
          )}
          {!isLogin && (
            <Button
              variant="outline"
              size="icon"
              onClick={() => onDelete(page)}
              className="text-red-600 hover:text-red-700 hover:bg-red-50"
              title="Delete Page"
              data-testid={`button-delete-page-${page.id}`}
            >
              <Trash2 className="w-3 h-3" />
            </Button>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => onTogglePublish(page)}
          disabled={publishPending}
          className={`w-full ${
            page.status === "published"
              ? "text-warning hover:text-warning hover:bg-warning/10"
              : "text-green-600 hover:text-green-700 hover:bg-green-50"
          }`}
          data-testid={`button-toggle-publish-${page.id}`}
        >
          <Zap className="w-3 h-3 mr-1" />
          {page.status === "published"
            ? "Unpublish Page"
            : `Publish to /${page.slug}`}
        </Button>

        {page.status === "published" && page.layout_type === "public" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onToggleHome(page)}
            disabled={homePending}
            className={`w-full ${
              isHome
                ? "bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200"
                : "text-blue-600 hover:text-blue-700 hover:bg-blue-50"
            }`}
            data-testid={`button-toggle-home-${page.id}`}
          >
            <Home className="w-3 h-3 mr-1" />
            {isHome ? "Remove as Home Page" : "Set as Home Page"}
          </Button>
        )}

        {page.status === "published" && (
          <div
            className="text-xs text-green-600 bg-green-50 rounded px-2 py-1 text-center"
            data-testid={`text-live-url-${page.id}`}
          >
            Live at:{" "}
            <a
              href={`/${page.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-medium"
            >
              /{page.slug}
            </a>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
