import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Bookmark } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBookmarks } from "@/hooks/useBookmarks";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function BookmarkButton({ entityType, entityId, size = "icon", className = "" }) {
  const { memberRole } = useMemberAccess();
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const [isToggling, setIsToggling] = useState(false);

  if (memberRole?.show_bookmarks === false) return null;

  const bookmarked = isBookmarked(entityType, entityId);

  const handleToggle = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isToggling) return;
    setIsToggling(true);
    try {
      await toggleBookmark(entityType, entityId);
    } catch (err) {
      console.error("Failed to toggle bookmark:", err);
    } finally {
      setIsToggling(false);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={(e) => e.preventDefault()}>
        <Button
          variant={bookmarked ? "default" : "outline"}
          size={size}
          onClick={handleToggle}
          disabled={isToggling}
          className={`${bookmarked ? "bg-amber-500 border-amber-500 text-white" : ""} ${className}`}
          data-testid={`bookmark-toggle-${entityType}-${entityId}`}
        >
          <Bookmark
            className={`w-4 h-4 ${bookmarked ? "fill-current" : ""}`}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {bookmarked ? "Remove bookmark" : "Bookmark this"}
      </TooltipContent>
    </Tooltip>
  );
}
