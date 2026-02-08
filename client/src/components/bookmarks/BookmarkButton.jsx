import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Bookmark } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBookmarks } from "@/hooks/useBookmarks";

export default function BookmarkButton({ entityType, entityId, variant = "ghost", size = "icon", className = "" }) {
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const [isToggling, setIsToggling] = useState(false);

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
          variant={variant}
          size={size}
          onClick={handleToggle}
          disabled={isToggling}
          className={className}
          data-testid={`bookmark-toggle-${entityType}-${entityId}`}
        >
          <Bookmark
            className={`w-4 h-4 transition-colors ${
              bookmarked ? "fill-current text-yellow-500" : ""
            }`}
          />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {bookmarked ? "Remove bookmark" : "Bookmark this"}
      </TooltipContent>
    </Tooltip>
  );
}
