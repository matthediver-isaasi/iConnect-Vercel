import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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
  CheckCircle2,
} from "lucide-react";

/**
 * A single page in the page manager. Renders as a grid card (viewMode='grid')
 * or a compact list row (viewMode='list'). Draggable by its grip handle so it
 * can be dropped onto a folder in the sidebar.
 */
export default function PageManagerItem({
  page,
  viewMode,
  pageMeta = null,
  selected = false,
  onToggleSelect,
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
  // Display-only picker mode (Task #2719): renders the card/row without any
  // management action buttons, drag handle, or select checkbox, and makes the
  // whole card/row clickable to choose this page. Used by the Canvas link
  // page-picker modal.
  selectMode = false,
  onSelectPage,
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

  const layoutLabel =
    page.layout_type === "member"
      ? "Portal"
      : page.layout_type === "hybrid"
      ? "Hybrid"
      : "Public";

  // ---- Display-only picker variant (no actions; whole card selects) ----
  if (selectMode) {
    const handleSelect = () => onSelectPage?.(page);
    const onKeyDown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleSelect();
      }
    };

    if (viewMode === "list") {
      return (
        <div
          role="button"
          tabIndex={0}
          onClick={handleSelect}
          onKeyDown={onKeyDown}
          className="flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 hover-elevate active-elevate-2 cursor-pointer"
          data-testid={`select-page-row-${page.id}`}
        >
          {isPinned && (
            <Pin className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="font-medium text-slate-900 truncate"
                data-testid={`text-page-title-${page.id}`}
              >
                {page.title}
              </span>
              {isHome && (
                <Badge className="bg-blue-100 text-blue-700 border-blue-300">
                  <Home className="w-3 h-3 mr-1" />
                  Home
                </Badge>
              )}
            </div>
            <span className="font-mono text-xs text-slate-500">
              /{page.slug}
            </span>
          </div>
          <Badge className={`${getStatusBadge(page.status)} flex-shrink-0`}>
            {page.status}
          </Badge>
          <Badge variant="outline" className="flex-shrink-0 hidden md:inline-flex">
            {layoutLabel}
          </Badge>
          <Badge variant="outline" className="flex-shrink-0 hidden md:inline-flex">
            {page.builder_type === "canvas" ? "Canvas" : "iEdit"}
          </Badge>
          {page.microsite_id && (
            <Badge
              variant="outline"
              className="flex-shrink-0 hidden md:inline-flex text-cyan-700 border-cyan-300"
              title="This page belongs to a microsite and is served under its URL prefix"
              data-testid={`badge-microsite-${page.id}`}
            >
              Microsite
            </Badge>
          )}
          <span className="text-xs text-slate-500 flex-shrink-0 hidden lg:inline w-28 text-right">
            {page.updated_date
              ? format(new Date(page.updated_date), "MMM d, yyyy")
              : "—"}
          </span>
        </div>
      );
    }

    return (
      <Card
        role="button"
        tabIndex={0}
        onClick={handleSelect}
        onKeyDown={onKeyDown}
        className="cursor-pointer hover-elevate active-elevate-2 border-slate-200"
        data-testid={`select-page-card-${page.id}`}
      >
        <CardHeader>
          <div className="flex items-start justify-between mb-2 gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {isPinned && (
                <Pin className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
              )}
              <CardTitle
                className="text-lg break-words min-w-0"
                data-testid={`text-page-title-${page.id}`}
              >
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
        <CardContent className="space-y-3">
          <div className="text-sm">
            <span className="text-slate-500">Slug:</span>
            <span className="ml-2 font-mono text-slate-700">/{page.slug}</span>
          </div>
          <div className="text-sm">
            <span className="text-slate-500">View:</span>
            <Badge variant="outline" className="ml-2">
              {layoutLabel}
            </Badge>
          </div>
          <div className="text-sm">
            <span className="text-slate-500">Builder:</span>
            <Badge variant="outline" className="ml-2">
              {page.builder_type === "canvas" ? "Canvas" : "iEdit"}
            </Badge>
            {page.microsite_id && (
              <Badge
                variant="outline"
                className="ml-2 text-cyan-700 border-cyan-300"
                title="This page belongs to a microsite and is served under its URL prefix"
                data-testid={`badge-microsite-${page.id}`}
              >
                Microsite
              </Badge>
            )}
          </div>
          {page.updated_date && (
            <div className="text-xs text-slate-500">
              Updated {format(new Date(page.updated_date), "MMM d, yyyy")}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ---- Audit & edit insights (Task #2749) ----
  const meta = pageMeta || null;
  const failingAudit = !!(meta?.audited && meta.errorCount > 0);
  const lastEditedDate = meta?.savedAt || page.updated_date || null;
  const lastEditedLabel = lastEditedDate
    ? format(new Date(lastEditedDate), "MMM d, yyyy")
    : null;

  const auditBadge = (() => {
    if (!meta || !meta.audited) {
      return (
        <Badge
          variant="outline"
          className="text-slate-500"
          data-testid={`badge-audit-${page.id}`}
        >
          Not audited
        </Badge>
      );
    }
    if (meta.errorCount === 0 && meta.warningCount === 0) {
      return (
        <Badge
          variant="outline"
          className="text-green-700 border-green-300 dark:text-green-400 dark:border-green-900"
          data-testid={`badge-audit-${page.id}`}
        >
          <CheckCircle2 className="w-3 h-3 mr-1" />
          No issues
        </Badge>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-1 flex-wrap"
        data-testid={`badge-audit-${page.id}`}
      >
        {meta.errorCount > 0 && (
          <Badge
            variant="destructive"
            data-testid={`badge-audit-errors-${page.id}`}
          >
            {meta.errorCount} {meta.errorCount === 1 ? "error" : "errors"}
          </Badge>
        )}
        {meta.warningCount > 0 && (
          <Badge
            variant="warning"
            data-testid={`badge-audit-warnings-${page.id}`}
          >
            {meta.warningCount} {meta.warningCount === 1 ? "warning" : "warnings"}
          </Badge>
        )}
      </span>
    );
  })();

  const lastEditedNode = (
    <div
      className="text-xs text-slate-500"
      data-testid={`text-last-edited-${page.id}`}
    >
      {meta?.savedByName ? (
        <>
          Last edited by{" "}
          <span className="text-slate-700 font-medium">{meta.savedByName}</span>
          {lastEditedLabel ? ` · ${lastEditedLabel}` : ""}
        </>
      ) : (
        <>Last edited {lastEditedLabel || "—"}</>
      )}
    </div>
  );

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

  const selectCheckbox = (
    <Checkbox
      checked={selected}
      onCheckedChange={() => onToggleSelect?.(page)}
      aria-label={selected ? "Deselect page" : "Select page"}
      title="Select page"
      className="flex-shrink-0"
      data-testid={`checkbox-select-${page.id}`}
    />
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
        className={`flex items-center gap-3 rounded-md border px-3 py-2 hover-elevate ${
          selected
            ? "bg-white border-blue-400 ring-1 ring-blue-400"
            : failingAudit
            ? "bg-red-50 border-red-300 dark:bg-red-950/30 dark:border-red-900"
            : "bg-white border-slate-200"
        }`}
        data-testid={`row-page-${page.id}`}
      >
        {selectCheckbox}
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
        {page.microsite_id && (
          <Badge
            variant="outline"
            className="flex-shrink-0 hidden md:inline-flex text-cyan-700 border-cyan-300"
            title="This page belongs to a microsite and is served under its URL prefix"
            data-testid={`badge-microsite-${page.id}`}
          >
            Microsite
          </Badge>
        )}
        {auditBadge && (
          <div className="flex-shrink-0 hidden lg:flex">{auditBadge}</div>
        )}
        <div className="flex-shrink-0 hidden lg:flex flex-col items-end w-40 text-right">
          <span className="text-xs text-slate-500">
            {page.updated_date
              ? format(new Date(page.updated_date), "MMM d, yyyy")
              : "—"}
          </span>
          {lastEditedNode}
        </div>
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
      className={`hover:shadow-lg transition-shadow ${
        selected
          ? "border-blue-400 ring-1 ring-blue-400"
          : failingAudit
          ? "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
          : "border-slate-200"
      }`}
      data-testid={`card-page-${page.id}`}
    >
      <CardHeader>
        <div className="flex items-start justify-between mb-2 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {selectCheckbox}
            {dragHandle}
            {isPinned && (
              <Pin className="w-3.5 h-3.5 text-blue-600 flex-shrink-0" />
            )}
            <CardTitle className="text-lg break-words min-w-0" data-testid={`text-page-title-${page.id}`}>
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
          {page.microsite_id && (
            <Badge
              variant="outline"
              className="ml-2 text-cyan-700 border-cyan-300"
              title="This page belongs to a microsite and is served under its URL prefix"
              data-testid={`badge-microsite-${page.id}`}
            >
              Microsite
            </Badge>
          )}
        </div>

        {page.updated_date && (
          <div className="text-xs text-slate-500">
            Updated {format(new Date(page.updated_date), "MMM d, yyyy")}
          </div>
        )}

        {lastEditedNode}

        {auditBadge && (
          <div className="text-sm flex items-center gap-2 flex-wrap">
            <span className="text-slate-500">Accessibility:</span>
            {auditBadge}
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
