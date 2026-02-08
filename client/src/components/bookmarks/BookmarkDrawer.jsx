import { useState } from "react";
import { Link } from "react-router-dom";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  ExternalLink,
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { useBookmarks } from "@/hooks/useBookmarks";
import { format } from "date-fns";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

const SECTION_CONFIG = [
  {
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
    getSubtitle: (item) => item.entity?.created_at ? format(new Date(item.entity.created_at), "d MMM yyyy") : null,
  },
  {
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
    getSubtitle: (item) => item.entity?.created_at ? format(new Date(item.entity.created_at), "d MMM yyyy") : null,
  },
  {
    key: "event",
    label: "Events",
    icon: Calendar,
    getUrl: (item) => createPageUrl("EventDetails") + "?id=" + item.entity_id,
    getTitle: (item) => item.entity?.title || "Untitled Event",
    getSubtitle: (item) => item.entity?.start_date ? format(new Date(item.entity.start_date), "d MMM yyyy") : null,
  },
  {
    key: "resource",
    label: "Resources",
    icon: FolderOpen,
    getUrl: (item) => createPageUrl("Resources"),
    getTitle: (item) => item.entity?.title || "Untitled Resource",
    getSubtitle: (item) => item.entity?.description ? item.entity.description.substring(0, 60) + (item.entity.description.length > 60 ? "..." : "") : null,
  },
  {
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
];

export default function BookmarkDrawer({ open, onOpenChange }) {
  const { grouped, toggleBookmark, isLoading, totalCount } = useBookmarks();
  const [expandedSections, setExpandedSections] = useState(
    SECTION_CONFIG.reduce((acc, s) => ({ ...acc, [s.key]: true }), {})
  );

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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[360px] sm:w-[420px] p-0 flex flex-col rounded-r-none">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <Bookmark className="w-5 h-5" />
            My Bookmarks
            {totalCount > 0 && (
              <Badge variant="secondary" className="ml-auto">
                {totalCount}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1 p-4">
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
            <div className="space-y-2">
              {SECTION_CONFIG.map((section) => {
                const items = grouped[section.key] || [];
                if (items.length === 0) return null;

                const SectionIcon = section.icon;
                const isOpen = expandedSections[section.key];

                return (
                  <Collapsible
                    key={section.key}
                    open={isOpen}
                    onOpenChange={() => toggleSection(section.key)}
                  >
                    <CollapsibleTrigger asChild>
                      <button
                        className="flex items-center gap-2 w-full px-2 py-2 text-sm font-medium text-muted-foreground hover-elevate rounded-md"
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
                    <CollapsibleContent>
                      <div className="space-y-1 pl-2 mt-1">
                        {items.map((item) => (
                          <Link
                            key={item.id}
                            to={section.getUrl(item)}
                            onClick={() => onOpenChange(false)}
                            className="group flex items-start gap-2 px-3 py-2 rounded-md hover-elevate text-sm"
                            data-testid={`bookmark-item-${item.entity_type}-${item.entity_id}`}
                          >
                            <div className="flex-1 min-w-0">
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
                              onClick={(e) => handleRemoveBookmark(item.entity_type, item.entity_id, e)}
                              data-testid={`bookmark-remove-${item.entity_type}-${item.entity_id}`}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </Link>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
