import React from "react";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Search, X, ChevronRight, ChevronDown } from "lucide-react";

export default function SubcategorySelector({ categories, selectedSubcategories, onChange, isLoading = false }) {
  const [openCategories, setOpenCategories] = React.useState({});
  const [searchQuery, setSearchQuery] = React.useState("");

  const toggleCategory = (categoryName) => {
    setOpenCategories(prev => ({
      ...prev,
      [categoryName]: !prev[categoryName]
    }));
  };

  const handleToggle = (subcategory) => {
    const newSelection = selectedSubcategories.includes(subcategory)
      ? selectedSubcategories.filter(s => s !== subcategory)
      : [...selectedSubcategories, subcategory];
    onChange(newSelection);
  };

  const filteredCategories = React.useMemo(() => {
    if (!searchQuery.trim()) return categories;

    const searchLower = searchQuery.toLowerCase();
    return categories.map(cat => {
      if (!cat.subcategories || cat.subcategories.length === 0) return null;

      const matchingSubcategories = cat.subcategories.filter(sub =>
        sub.toLowerCase().includes(searchLower)
      );

      const categoryNameMatches = cat.name.toLowerCase().includes(searchLower);

      if (matchingSubcategories.length === 0 && !categoryNameMatches) {
        return null;
      }

      return {
        ...cat,
        subcategories: matchingSubcategories.length > 0 ? matchingSubcategories : cat.subcategories
      };
    }).filter(Boolean);
  }, [categories, searchQuery]);

  // Auto-expand categories with selected items
  React.useEffect(() => {
    const newOpenCategories = {};
    categories.forEach(cat => {
      if (cat.subcategories?.some(sub => selectedSubcategories.includes(sub))) {
        newOpenCategories[cat.name] = true;
      }
    });
    setOpenCategories(prev => ({ ...prev, ...newOpenCategories }));
  }, [categories, selectedSubcategories]);

  // Show loading state only when actually loading
  if (isLoading) {
    return (
      <div className="text-sm text-slate-500 italic">
        Loading categories...
      </div>
    );
  }

  // Return null if no categories - parent should handle hiding the card
  if (!categories || categories.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <Label>Categories</Label>
      
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
        <Input
          placeholder="Search categories..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10 pr-10"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Selected count */}
      {selectedSubcategories.length > 0 && (
        <div className="text-xs text-blue-600 font-medium">
          {selectedSubcategories.length} selected
        </div>
      )}

      {/* Categories list */}
      <div className="border border-slate-200 rounded-lg max-h-64 overflow-y-auto">
        {filteredCategories.map((category) => {
          const hasSubcategories = category.subcategories && category.subcategories.length > 0;
          
          if (!hasSubcategories) return null;

          const isOpen = openCategories[category.name];
          const sortedSubcategories = [...category.subcategories].sort((a, b) => 
            a.localeCompare(b, undefined, { sensitivity: 'base' })
          );

          return (
            <div key={category.id} className="border-b border-slate-200 last:border-b-0">
              <button
                onClick={() => toggleCategory(category.name)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm font-semibold hover:bg-slate-50 text-purple-700"
              >
                <span>{category.name}</span>
                {isOpen ? (
                  <ChevronDown className="w-4 h-4" />
                ) : (
                  <ChevronRight className="w-4 h-4" />
                )}
              </button>
              
              {isOpen && (
                <div className="px-3 pb-2 space-y-1">
                  {sortedSubcategories.map((subcategory) => {
                    const isChecked = selectedSubcategories.includes(subcategory);
                    
                    return (
                      <div 
                        key={subcategory}
                        className={`flex items-start gap-2 px-2 py-1 rounded cursor-pointer transition-colors ${
                          isChecked ? 'bg-blue-50' : 'hover:bg-slate-50'
                        }`}
                        onClick={() => handleToggle(subcategory)}
                      >
                        <Checkbox
                          id={`editor-sub-${subcategory}`}
                          checked={isChecked}
                          onCheckedChange={() => handleToggle(subcategory)}
                          className="mt-0.5 flex-shrink-0 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                        />
                        <Label
                          htmlFor={`editor-sub-${subcategory}`}
                          className={`text-xs cursor-pointer break-words flex-1 leading-tight pt-0.5 ${
                            isChecked ? 'text-blue-700 font-medium' : 'text-slate-700'
                          }`}
                        >
                          {subcategory}
                        </Label>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Selected items display */}
      {selectedSubcategories.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 bg-blue-50 rounded-lg">
          {selectedSubcategories.map((sub, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded"
            >
              {sub}
              <button
                onClick={() => handleToggle(sub)}
                className="hover:bg-blue-200 rounded-full p-0.5"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}