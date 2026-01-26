import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Search, Type, Image, Layout, Zap, Square } from "lucide-react";

export default function IEditElementPalette({ onClose, onSelectTemplate }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("all");

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['iedit-templates'],
    queryFn: async () => await base44.entities.IEditElementTemplate.list({ 
      filter: { is_active: true }, 
      sort: { display_order: 'asc' } 
    }) || [],
    staleTime: 0
  });

  const categories = [
    { id: "all", label: "All", icon: Layout },
    { id: "layout", label: "Layout", icon: Layout },
    { id: "content", label: "Content", icon: Type },
    { id: "media", label: "Media", icon: Image },
    { id: "interactive", label: "Interactive", icon: Zap }
  ];

  const filteredTemplates = templates.filter(template => {
    const matchesSearch = template.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          template.description?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === "all" || template.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const iconMap = {
    Type, Image, Layout, Zap, Square
  };

  const getIcon = (iconName) => {
    const Icon = iconMap[iconName] || Square;
    return <Icon className="w-8 h-8" />;
  };

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-white border-l border-slate-200 shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900">Add Element</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Search elements..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-1 p-4 border-b border-slate-200 overflow-x-auto">
        {categories.map((cat) => {
          const Icon = cat.icon;
          return (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors ${
                selectedCategory === cat.id
                  ? 'bg-blue-100 text-blue-700 font-medium'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Icon className="w-4 h-4" />
              {cat.label}
            </button>
          );
        })}
      </div>

      {/* Templates List */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="text-center py-8 text-slate-500">Loading templates...</div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-slate-600 mb-2">No elements found</p>
            <p className="text-sm text-slate-500">Try adjusting your search or filters</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredTemplates.map((template) => (
              <Card
                key={template.id}
                className="border-slate-200 hover:border-blue-300 hover:shadow-md transition-all cursor-pointer"
                onClick={() => onSelectTemplate(template)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="p-2 bg-slate-100 rounded-lg text-slate-600">
                      {getIcon(template.icon)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-slate-900 mb-1">{template.name}</h3>
                      {template.description && (
                        <p className="text-sm text-slate-600 line-clamp-2">{template.description}</p>
                      )}
                      {template.available_variants && template.available_variants.length > 1 && (
                        <p className="text-xs text-slate-500 mt-2">
                          {template.available_variants.length} variants available
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}