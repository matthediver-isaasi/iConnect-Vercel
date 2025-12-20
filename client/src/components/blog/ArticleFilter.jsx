import React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Search, X, ChevronRight, ChevronDown } from "lucide-react";

export default function ArticleFilter({ 
  categories,
  selectedSubcategories,
  onSubcategoryToggle,
  searchQuery,
  onSearchChange,
  onClearSearch,
  isLoading = false,
  displayName = 'Articles'
}) {
  const [openCategories, setOpenCategories] = React.useState({});
  const [expandedSubcategories, setExpandedSubcategories] = React.useState({});
  const [searchOpen, setSearchOpen] = React.useState(true);

  // Expand all categories when search is focused
  const expandAllCategories = () => {
    if (!categories || categories.length === 0) return;
    const allOpen = {};
    categories.forEach(cat => {
      allOpen[cat.name] = true;
    });
    setOpenCategories(allOpen);
  };

  const toggleCategory = (categoryName) => {
    setOpenCategories(prev => ({
      ...prev,
      [categoryName]: !prev[categoryName]
    }));
  };

  const toggleSubcategoryExpansion = (categoryName) => {
    setExpandedSubcategories(prev => ({
      ...prev,
      [categoryName]: !prev[categoryName]
    }));
  };

  const clearCategoryFilters = (categoryName, e) => {
    e.stopPropagation();
    
    const category = categories.find(c => c.name === categoryName);
    if (category && category.subcategories) {
      const subcatsToRemove = category.subcategories;
      
      subcatsToRemove.forEach(subcat => {
        if (selectedSubcategories.includes(subcat)) {
          onSubcategoryToggle(subcat);
        }
      });
    }
  };

  const hasSelectedSubcategories = (categoryName) => {
    const category = categories.find(c => c.name === categoryName);
    if (!category || !category.subcategories) return false;
    
    return category.subcategories.some(subcat => selectedSubcategories.includes(subcat));
  };

  // Auto-expand categories that have selected subcategories on mount
  React.useEffect(() => {
    if (!categories || categories.length === 0) return;
    
    const newOpenCategories = {};
    categories.forEach(cat => {
      if (hasSelectedSubcategories(cat.name)) {
        newOpenCategories[cat.name] = true;
      }
    });
    setOpenCategories(prev => ({ ...prev, ...newOpenCategories }));
  }, [categories]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-slate-500 italic">
          Loading categories...
        </div>
      </div>
    );
  }

  if (!categories || categories.length === 0) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-slate-500 italic">
          No categories available
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <style>{`
        .accordion-content {
          overflow: hidden;
          transition: max-height 0.3s ease-in-out, opacity 0.3s ease-in-out;
        }
        .accordion-content[data-state="closed"] {
          max-height: 0;
          opacity: 0;
        }
        .accordion-content[data-state="open"] {
          max-height: 1000px;
          opacity: 1;
        }
        .accordion-content[data-state="open-category"] {
          max-height: 2000px;
          opacity: 1;
        }
      `}</style>

      {/* Search Accordion */}
      <div className="border-b border-slate-200 py-3">
        <button
          onClick={() => setSearchOpen(!searchOpen)}
          className="w-full flex items-center justify-between px-2 py-1.5 text-sm font-semibold rounded-md transition-colors text-left hover:bg-slate-100 text-slate-700"
        >
          <span>Search {displayName}</span>
          {searchOpen ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-600 flex-shrink-0 transition-transform duration-200 ease-in-out" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-600 flex-shrink-0 transition-transform duration-200 ease-in-out" />
          )}
        </button>
        <div
          className="accordion-content"
          data-state={searchOpen ? "open" : "closed"}
        >
          <div className="pt-2">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => onSearchChange(e.target.value)}
                onFocus={expandAllCategories}
                className="pl-10 pr-10"
                data-testid="input-search-articles"
              />
              {searchQuery && (
                <button
                  onClick={onClearSearch}
                  className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Category Filter */}
      <div>
        {categories.map((category) => {
          const hasSubcategories = category.subcategories && category.subcategories.length > 0;
          
          if (!hasSubcategories) {
            return null;
          }

          const isOpen = openCategories[category.name];
          const isExpanded = expandedSubcategories[category.name];
          
          const sortedSubcategories = [...category.subcategories].sort((a, b) => 
            a.localeCompare(b, undefined, { sensitivity: 'base' })
          );
          
          const subcategoriesToShow = isExpanded 
            ? sortedSubcategories 
            : sortedSubcategories.slice(0, 8);
          
          const hasMore = sortedSubcategories.length > 8;
          const hasFilters = hasSelectedSubcategories(category.name);

          return (
            <div key={category.id} className="border-b border-slate-200 py-3">
              <button
                onClick={() => toggleCategory(category.name)}
                className="w-full flex items-center justify-between px-2 py-1.5 text-sm font-semibold rounded-md transition-colors text-left hover:bg-slate-100 text-purple-700"
              >
                <div className="flex items-center gap-2 flex-1">
                  <span className="break-words">{category.name}</span>
                  {hasFilters && (
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                      {category.subcategories.filter(sub => selectedSubcategories.includes(sub)).length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {hasFilters && (
                    <span
                      onClick={(e) => clearCategoryFilters(category.name, e)}
                      className="text-xs text-blue-600 hover:text-blue-700 hover:underline"
                    >
                      Clear
                    </span>
                  )}
                  {isOpen ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-600 flex-shrink-0 transition-transform duration-200 ease-in-out" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-600 flex-shrink-0 transition-transform duration-200 ease-in-out" />
                  )}
                </div>
              </button>
              
              <div
                className="accordion-content"
                data-state={isOpen ? "open-category" : "closed"}
              >
                <div className="space-y-0.5 pt-1">
                  {subcategoriesToShow.map((subcategory) => {
                    const isChecked = selectedSubcategories.includes(subcategory);
                    
                    return (
                      <div 
                        key={subcategory}
                        className={`flex items-start gap-2 px-2 py-1 rounded-md cursor-pointer transition-colors ${
                          isChecked ? 'bg-blue-50' : 'hover:bg-slate-50'
                        }`}
                        onClick={(e) => {
                          if (e.target === e.currentTarget) {
                            onSubcategoryToggle(subcategory);
                          }
                        }}
                      >
                        <Checkbox
                          id={`article-subcategory-${subcategory}`}
                          checked={isChecked}
                          onCheckedChange={() => onSubcategoryToggle(subcategory)}
                          className="mt-0.5 flex-shrink-0 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                        />
                        <Label
                          htmlFor={`article-subcategory-${subcategory}`}
                          className={`text-xs cursor-pointer break-words flex-1 leading-tight pt-0.5 ${
                            isChecked ? 'text-blue-700 font-medium' : 'text-slate-700'
                          }`}
                        >
                          {subcategory}
                        </Label>
                      </div>
                    );
                  })}
                  
                  {hasMore && (
                    <button
                      onClick={() => toggleSubcategoryExpansion(category.name)}
                      className="w-full text-left px-2 py-1 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-md transition-colors"
                    >
                      {isExpanded ? '− Show less' : `+ View ${sortedSubcategories.length - 8} more`}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}