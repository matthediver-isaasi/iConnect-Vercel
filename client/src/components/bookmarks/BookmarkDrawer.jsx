import { useState, useMemo, useEffect } from "react";
import { Link } from "react-router-dom";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Bookmark,
  BookOpen,
  Newspaper,
  Calendar,
  FolderOpen,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  X,
  GripVertical,
  AlertTriangle,
  Trash2,
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { useBookmarks } from "@/hooks/useBookmarks";
import { format } from "date-fns";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const SECTION_MAP = {
  blog_post: {
    key: "blog_post",
    label: "Blog Posts",
    icon: BookOpen,
    getUrl: (item) => {
      if (item.entity?.slug) {
        return createPageUrl("ArticleView") + "?slug=" + item.entity.slug;
      }
      return createPageUrl("ArticleView");
    },
    getTitle: (item) => item.entity?.title || "Untitled Post",
    getSubtitle: (item) => item.entity?.published_date ? format(new Date(item.entity.published_date), "d MMM yyyy") : null,
  },
  news_post: {
    key: "news_post",
    label: "News",
    icon: Newspaper,
    getUrl: (item) => {
      if (item.entity?.slug) {
        return createPageUrl("NewsView") + "?slug=" + item.entity.slug;
      }
      return createPageUrl("News");
    },
    getTitle: (item) => item.entity?.title || "Untitled News",
    getSubtitle: (item) => item.entity?.published_date ? format(new Date(item.entity.published_date), "d MMM yyyy") : null,
  },
  event: {
    key: "event",
    label: "Events",
    icon: Calendar,
    getUrl: (item) => createPageUrl("EventDetails") + "?id=" + item.entity_id,
    getTitle: (item) => item.entity?.title || "Untitled Event",
    getSubtitle: (item) => item.entity?.start_date ? format(new Date(item.entity.start_date), "d MMM yyyy") : null,
  },
  resource: {
    key: "resource",
    label: "Resources",
    icon: FolderOpen,
    getUrl: (item) => createPageUrl("Resources"),
    getTitle: (item) => item.entity?.title || "Untitled Resource",
    getSubtitle: (item) => item.entity?.description ? item.entity.description.substring(0, 60) + (item.entity.description.length > 60 ? "..." : "") : null,
  },
  forum_thread: {
    key: "forum_thread",
    label: "Forum Threads",
    icon: MessageSquare,
    getUrl: (item) => createPageUrl("ForumThread") + "?threadId=" + item.entity_id,
    getTitle: (item) => item.entity?.title || "Untitled Thread",
    getSubtitle: (item) => {
      const parts = [];
      if (item.entity?.post_count) parts.push(`${item.entity.post_count} posts`);
      if (item.entity?.created_at) parts.push(format(new Date(item.entity.created_at), "d MMM yyyy"));
      return parts.join(" · ") || null;
    },
  },
};

function SortableCategorySection({ id, section, items, isOpen, onToggle, onOpenChange, onRemoveBookmark, onItemReorder }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative',
    zIndex: isDragging ? 10 : 'auto',
  };

  const SectionIcon = section.icon;

  return (
    <div ref={setNodeRef} style={style} className="border shadow-sm bg-card">
      <Collapsible open={isOpen} onOpenChange={onToggle}>
        <div className="flex items-center gap-1 px-1">
          <button
            className="cursor-grab active:cursor-grabbing p-1 text-muted-foreground/50 hover:text-muted-foreground touch-none"
            data-testid={`bookmark-section-drag-${section.key}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
          <CollapsibleTrigger asChild>
            <button
              className="flex items-center gap-2 flex-1 px-2 py-2 text-sm font-medium text-muted-foreground hover-elevate"
              data-testid={`bookmark-section-toggle-${section.key}`}
            >
              {isOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <SectionIcon className="w-4 h-4" />
              <span>{section.label}</span>
              <Badge variant="secondary" className="ml-auto text-xs">
                {items.length}
              </Badge>
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="border-t">
            <SortableItemList
              section={section}
              items={items}
              onOpenChange={onOpenChange}
              onRemoveBookmark={onRemoveBookmark}
              onItemReorder={onItemReorder}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function SortableItemList({ section, items, onOpenChange, onRemoveBookmark, onItemReorder }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const itemIds = items.map((item) => item.entity_id);

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = itemIds.indexOf(active.id);
    const newIndex = itemIds.indexOf(over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = arrayMove(itemIds, oldIndex, newIndex);
    onItemReorder(section.key, newOrder);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-1 pl-2 mt-1">
          {items.map((item) => (
            <SortableBookmarkItem
              key={item.entity_id}
              item={item}
              section={section}
              onOpenChange={onOpenChange}
              onRemoveBookmark={onRemoveBookmark}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableBookmarkItem({ item, section, onOpenChange, onRemoveBookmark }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.entity_id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative',
    zIndex: isDragging ? 10 : 'auto',
  };

  const isUnavailable = item.unavailable;

  if (isUnavailable) {
    return (
      <div ref={setNodeRef} style={style} className="flex items-start gap-1">
        <button
          className="cursor-grab active:cursor-grabbing p-1 mt-1.5 text-muted-foreground/50 hover:text-muted-foreground shrink-0 touch-none"
          data-testid={`bookmark-item-drag-${item.entity_type}-${item.entity_id}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="w-3 h-3" />
        </button>
        <div
          className="group flex items-start gap-2 flex-1 min-w-0 px-2 py-1.5 text-sm overflow-hidden opacity-60"
          data-testid={`bookmark-item-${item.entity_type}-${item.entity_id}`}
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
          <div className="flex-1 min-w-0 overflow-hidden">
            <p className="font-medium truncate text-muted-foreground line-through">
              {section.getTitle(item)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              No longer available
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ visibility: "visible" }}
            onClick={(e) => onRemoveBookmark(item.entity_type, item.entity_id, e)}
            data-testid={`bookmark-remove-${item.entity_type}-${item.entity_id}`}
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-start gap-1">
      <button
        className="cursor-grab active:cursor-grabbing p-1 mt-1.5 text-muted-foreground/50 hover:text-muted-foreground shrink-0 touch-none"
        data-testid={`bookmark-item-drag-${item.entity_type}-${item.entity_id}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="w-3 h-3" />
      </button>
      <Link
        to={section.getUrl(item)}
        onClick={() => onOpenChange(false)}
        className="group flex items-start gap-2 flex-1 min-w-0 px-2 py-1.5 hover-elevate text-sm overflow-hidden"
        data-testid={`bookmark-item-${item.entity_type}-${item.entity_id}`}
      >
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="font-medium truncate text-foreground">
            {section.getTitle(item)}
          </p>
          {section.getSubtitle(item) && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {section.getSubtitle(item)}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ visibility: "visible" }}
          onClick={(e) => onRemoveBookmark(item.entity_type, item.entity_id, e)}
          data-testid={`bookmark-remove-${item.entity_type}-${item.entity_id}`}
        >
          <Trash2 className="w-3 h-3" />
        </Button>
      </Link>
    </div>
  );
}

export default function BookmarkDrawer({ open, onOpenChange }) {
  const { grouped, categoryOrder, toggleBookmark, reorderCategories, reorderItems, refetchEnriched, isLoading, totalCount } = useBookmarks();
  const [expandedSections, setExpandedSections] = useState(
    Object.keys(SECTION_MAP).reduce((acc, key) => ({ ...acc, [key]: true }), {})
  );

  useEffect(() => {
    if (open) {
      refetchEnriched();
    }
  }, [open, refetchEnriched]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const orderedSections = useMemo(() => {
    return categoryOrder
      .filter((key) => SECTION_MAP[key])
      .map((key) => SECTION_MAP[key]);
  }, [categoryOrder]);

  const visibleCategoryIds = useMemo(() => {
    return orderedSections
      .filter((s) => (grouped[s.key] || []).length > 0)
      .map((s) => s.key);
  }, [orderedSections, grouped]);

  const toggleSection = (key) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleRemoveBookmark = async (entityType, entityId, e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await toggleBookmark(entityType, entityId);
    } catch (err) {
      console.error("Failed to remove bookmark:", err);
    }
  };

  const handleCategoryDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIdx = visibleCategoryIds.indexOf(active.id);
    const newIdx = visibleCategoryIds.indexOf(over.id);
    if (oldIdx === -1 || newIdx === -1) return;

    const reorderedVisible = arrayMove([...visibleCategoryIds], oldIdx, newIdx);
    const hiddenKeys = categoryOrder.filter((k) => !visibleCategoryIds.includes(k));
    const newOrder = [...reorderedVisible, ...hiddenKeys];
    reorderCategories(newOrder);
  };

  const handleItemReorder = (entityType, orderedIds) => {
    reorderItems(entityType, orderedIds);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" hideClose className="!max-w-[360px] sm:!max-w-[420px] w-[360px] sm:w-[420px] p-0 flex flex-col rounded-none">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <Bookmark className="w-5 h-5" />
            <span className="flex-1">My Bookmarks</span>
            {totalCount > 0 && (
              <Badge variant="secondary">
                {totalCount}
              </Badge>
            )}
            <SheetClose asChild>
              <Button variant="ghost" size="icon" data-testid="button-bookmarks-close">
                <X className="h-4 w-4" />
              </Button>
            </SheetClose>
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
            </div>
          ) : totalCount === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Bookmark className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">No bookmarks yet</p>
              <p className="text-xs mt-1">
                Save blogs, news, events, resources and forum threads for quick access
              </p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleCategoryDragEnd}
            >
              <SortableContext items={visibleCategoryIds} strategy={verticalListSortingStrategy}>
                <div className="space-y-3">
                  {orderedSections.map((section) => {
                    const items = grouped[section.key] || [];
                    if (items.length === 0) return null;

                    return (
                      <SortableCategorySection
                        key={section.key}
                        id={section.key}
                        section={section}
                        items={items}
                        isOpen={expandedSections[section.key]}
                        onToggle={() => toggleSection(section.key)}
                        onOpenChange={onOpenChange}
                        onRemoveBookmark={handleRemoveBookmark}
                        onItemReorder={handleItemReorder}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
