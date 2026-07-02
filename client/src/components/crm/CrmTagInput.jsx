import { useState, useEffect, useRef, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { X, Plus, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useTagColors } from "@/hooks/useTagColors";
import { toast } from "sonner";

function ColorPicker({ selectedColor, onSelect, palette }) {
  return (
    <div className="flex flex-wrap gap-1.5 p-2" data-testid="color-picker">
      {palette.map((color) => (
        <button
          key={color}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(color);
          }}
          className={`w-5 h-5 rounded-full border-2 transition-transform ${
            selectedColor === color
              ? "border-slate-900 dark:border-white scale-110"
              : "border-transparent hover:scale-110"
          }`}
          style={{ backgroundColor: color }}
          data-testid={`color-swatch-${color.replace("#", "")}`}
        />
      ))}
      {selectedColor && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(null);
          }}
          className="w-5 h-5 rounded-full border-2 border-dashed border-slate-300 flex items-center justify-center text-slate-400 hover:scale-110 transition-transform"
          data-testid="color-swatch-clear"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

export default function CrmTagInput({ tags = [], onChange, entityType, disabled = false }) {
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [showNewTagColorPicker, setShowNewTagColorPicker] = useState(false);
  const [newTagColor, setNewTagColor] = useState(null);
  const inputRef = useRef(null);
  const suggestionsRef = useRef(null);

  const { getTagColor, getTagStyle, setTagColor, TAG_COLOR_PALETTE } =
    useTagColors(entityType);

  const entityConfig = {
    organization: {
      queryKey: ['admin-organizations-tags'],
      listFn: () => base44.entities.Organization.list(),
    },
    member: {
      queryKey: ['admin-members-tags'],
      listFn: () => base44.entities.Member.list(),
    },
  };

  const config = entityConfig[entityType];

  const { data: entities = [], isLoading } = useQuery({
    queryKey: config.queryKey,
    queryFn: async () => {
      const results = await config.listFn();
      return results || [];
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!config,
  });

  const existingTags = useMemo(() => {
    const tagSet = new Set();
    entities.forEach(entity => {
      if (entity.tags && Array.isArray(entity.tags)) {
        entity.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
  }, [entities]);

  const filteredSuggestions = useMemo(() => {
    if (!inputValue.trim()) return [];
    const searchLower = inputValue.toLowerCase().trim();
    return existingTags.filter(tag =>
      tag.toLowerCase().includes(searchLower) && !tags.includes(tag)
    );
  }, [inputValue, existingTags, tags]);

  const exactMatch = useMemo(() => {
    const searchLower = inputValue.toLowerCase().trim();
    return existingTags.some(tag => tag.toLowerCase() === searchLower);
  }, [inputValue, existingTags]);

  const alreadyHasTag = useMemo(() => {
    const trimmed = inputValue.trim().toLowerCase();
    return tags.some(t => t.toLowerCase() === trimmed);
  }, [inputValue, tags]);

  const canAddNew = inputValue.trim() &&
    !alreadyHasTag &&
    !exactMatch;

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [inputValue]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        inputRef.current &&
        !inputRef.current.contains(e.target) &&
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target)
      ) {
        setShowSuggestions(false);
        setShowNewTagColorPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addTag = async (tag, color) => {
    if (!tags.some(t => t.toLowerCase() === tag.toLowerCase())) {
      onChange([...tags, tag]);
    }
    if (color) {
      try {
        await setTagColor(tag, color);
      } catch (err) {
        console.error("Failed to save tag color:", err);
        toast.warning("Tag added but colour could not be saved.");
      }
    }
    setInputValue("");
    setShowSuggestions(false);
    setShowNewTagColorPicker(false);
    setNewTagColor(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const maxIndex = canAddNew ? filteredSuggestions.length : filteredSuggestions.length - 1;
      setHighlightedIndex(prev => Math.min(prev + 1, maxIndex));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < filteredSuggestions.length) {
        addTag(filteredSuggestions[highlightedIndex]);
      } else if (highlightedIndex === filteredSuggestions.length && canAddNew) {
        if (showNewTagColorPicker) {
          addTag(inputValue.trim(), newTagColor);
        } else {
          setShowNewTagColorPicker(true);
        }
      } else if (inputValue.trim() && !alreadyHasTag) {
        if (showNewTagColorPicker) {
          addTag(inputValue.trim(), newTagColor);
        } else {
          setShowNewTagColorPicker(true);
        }
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setShowNewTagColorPicker(false);
    }
  };

  const removeTag = (tagToRemove) => {
    onChange(tags.filter(tag => tag !== tagToRemove));
  };

  const safeTags = Array.isArray(tags) ? tags : [];

  return (
    <div className="space-y-3">
      {!disabled && (
        <div className="relative">
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={handleKeyDown}
            placeholder="Type to add tags..."
            className="text-sm"
            data-testid={`input-${entityType}-tags`}
          />
          {isLoading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400" />
          )}

          {showSuggestions && inputValue.trim() && (filteredSuggestions.length > 0 || canAddNew) && (
            <div
              ref={suggestionsRef}
              className="absolute z-50 w-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg max-h-64 overflow-y-auto"
            >
              {filteredSuggestions.map((tag, index) => {
                const tagStyle = getTagStyle(tag);
                const hasColor = !!getTagColor(tag);
                return (
                  <button
                    key={tag}
                    onClick={() => addTag(tag)}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2 ${
                      highlightedIndex === index ? 'bg-slate-100 dark:bg-slate-700' : ''
                    }`}
                    data-testid={`${entityType}-tag-suggestion-${index}`}
                  >
                    {hasColor ? (
                      <Badge
                        variant="secondary"
                        className="text-xs no-default-hover-elevate no-default-active-elevate"
                        style={tagStyle}
                      >
                        {tag}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate">
                        {tag}
                      </Badge>
                    )}
                  </button>
                );
              })}

              {canAddNew && (
                <div className="border-t border-slate-100 dark:border-slate-700">
                  <button
                    onClick={() => {
                      if (showNewTagColorPicker) {
                        addTag(inputValue.trim(), newTagColor);
                      } else {
                        setShowNewTagColorPicker(true);
                      }
                    }}
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2 ${
                      highlightedIndex === filteredSuggestions.length ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                    data-testid={`button-add-new-${entityType}-tag`}
                  >
                    <Plus className="w-4 h-4 text-blue-600" />
                    <span className="text-blue-600">
                      {showNewTagColorPicker ? `Confirm "${inputValue.trim()}"` : `Add "${inputValue.trim()}"`}
                    </span>
                    {newTagColor && (
                      <span
                        className="w-3 h-3 rounded-full ml-auto shrink-0"
                        style={{ backgroundColor: newTagColor }}
                      />
                    )}
                  </button>
                  {showNewTagColorPicker && (
                    <div className="px-2 pb-2">
                      <p className="text-xs text-slate-500 dark:text-slate-400 px-1 mb-1">Pick a colour (optional):</p>
                      <ColorPicker
                        selectedColor={newTagColor}
                        onSelect={(c) => setNewTagColor(c)}
                        palette={TAG_COLOR_PALETTE}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {safeTags.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {safeTags.map((tag, index) => {
            const tagStyle = getTagStyle(tag);
            const hasColor = !!getTagColor(tag);
            return (
              <Badge
                key={index}
                variant={hasColor ? "secondary" : "secondary"}
                className="gap-1 no-default-hover-elevate no-default-active-elevate"
                style={hasColor ? tagStyle : undefined}
                data-testid={`badge-tag-${entityType}-${index}`}
              >
                {tag}
                {!disabled && (
                  <button
                    onClick={() => removeTag(tag)}
                    className="hover:opacity-70"
                    data-testid={`button-remove-${entityType}-tag-${index}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </Badge>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-slate-500">No tags assigned</p>
      )}
    </div>
  );
}
