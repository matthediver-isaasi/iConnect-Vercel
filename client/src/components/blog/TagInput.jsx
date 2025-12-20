import { useState, useEffect, useRef, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X, Plus, Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "../../api/base44Client";

export default function TagInput({ tags, onChange }) {
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef(null);
  const suggestionsRef = useRef(null);

  const { data: resources = [], isLoading } = useQuery({
    queryKey: ['/api/resources/tags'],
    queryFn: async () => {
      const resources = await base44.entities.Resource.list();
      return resources;
    },
    staleTime: 5 * 60 * 1000,
  });

  const existingTags = useMemo(() => {
    const tagSet = new Set();
    resources.forEach(resource => {
      if (resource.tags && Array.isArray(resource.tags)) {
        resource.tags.forEach(tag => tagSet.add(tag));
      }
    });
    return Array.from(tagSet).sort((a, b) => 
      a.toLowerCase().localeCompare(b.toLowerCase())
    );
  }, [resources]);

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

  const canAddNew = inputValue.trim() && 
    !tags.includes(inputValue.trim()) && 
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
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addTag = (tag) => {
    if (!tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setInputValue("");
    setShowSuggestions(false);
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
        addTag(inputValue.trim());
      } else if (inputValue.trim() && !tags.includes(inputValue.trim())) {
        addTag(inputValue.trim());
      }
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const removeTag = (tagToRemove) => {
    onChange(tags.filter(tag => tag !== tagToRemove));
  };

  return (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader>
        <CardTitle className="text-base">Tags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="relative">
          <Input
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={handleKeyDown}
            placeholder="Type to search tags..."
            className="text-sm"
            data-testid="input-tags"
          />
          {isLoading && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400" />
          )}
          
          {showSuggestions && inputValue.trim() && (filteredSuggestions.length > 0 || canAddNew) && (
            <div 
              ref={suggestionsRef}
              className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto"
            >
              {filteredSuggestions.map((tag, index) => (
                <button
                  key={tag}
                  onClick={() => addTag(tag)}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-slate-100 flex items-center gap-2 ${
                    highlightedIndex === index ? 'bg-slate-100' : ''
                  }`}
                  data-testid={`tag-suggestion-${index}`}
                >
                  <Badge variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                </button>
              ))}
              
              {canAddNew && (
                <button
                  onClick={() => addTag(inputValue.trim())}
                  className={`w-full px-3 py-2 text-left text-sm hover:bg-blue-50 flex items-center gap-2 border-t border-slate-100 ${
                    highlightedIndex === filteredSuggestions.length ? 'bg-blue-50' : ''
                  }`}
                  data-testid="button-add-new-tag"
                >
                  <Plus className="w-4 h-4 text-blue-600" />
                  <span className="text-blue-600">Add "{inputValue.trim()}"</span>
                </button>
              )}
            </div>
          )}
        </div>
        
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag, index) => (
              <Badge key={index} variant="secondary" className="gap-1">
                {tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="hover:text-red-600"
                  data-testid={`button-remove-tag-${index}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
