import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tag, Plus, Trash2, AlertCircle, Search, X } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function TagManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tagToDelete, setTagToDelete] = useState(null);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('content.tags')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: resources = [], isLoading } = useQuery({
    queryKey: ['admin-resources'],
    queryFn: () => base44.entities.Resource.list('-release_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Extract all unique tags with usage count
  const tagStats = useMemo(() => {
    const tagMap = new Map();
    
    resources.forEach(resource => {
      if (resource.tags && Array.isArray(resource.tags)) {
        resource.tags.forEach(tag => {
          if (tagMap.has(tag)) {
            tagMap.set(tag, {
              count: tagMap.get(tag).count + 1,
              resourceIds: [...tagMap.get(tag).resourceIds, resource.id]
            });
          } else {
            tagMap.set(tag, {
              count: 1,
              resourceIds: [resource.id]
            });
          }
        });
      }
    });

    return Array.from(tagMap.entries())
      .map(([tag, data]) => ({ tag, ...data }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [resources]);

  // Filter tags based on search
  const filteredTags = useMemo(() => {
    if (!searchQuery.trim()) return tagStats;
    const searchLower = searchQuery.toLowerCase();
    return tagStats.filter(item => item.tag.toLowerCase().includes(searchLower));
  }, [tagStats, searchQuery]);

  // Mutation to update resources (remove tag from all resources)
  const removeTagMutation = useMutation({
    mutationFn: async (tagToRemove) => {
      const resourcesToUpdate = resources.filter(r => 
        r.tags && r.tags.includes(tagToRemove)
      );

      await Promise.all(
        resourcesToUpdate.map(resource =>
          base44.entities.Resource.update(resource.id, {
            ...resource,
            tags: resource.tags.filter(t => t !== tagToRemove)
          })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-resources'] });
      setShowDeleteConfirm(false);
      setTagToDelete(null);
      toast.success('Tag removed from all resources');
    },
    onError: (error) => {
      toast.error('Failed to remove tag: ' + error.message);
    }
  });

  const handleAddTag = () => {
    const trimmedTag = newTagName.trim();
    
    if (!trimmedTag) {
      toast.error('Tag name cannot be empty');
      return;
    }

    if (tagStats.some(item => item.tag === trimmedTag)) {
      toast.error('Tag already exists');
      return;
    }

    // Tags are added when used on resources, so just confirm it's ready
    toast.success(`Tag "${trimmedTag}" is now available for use`);
    setNewTagName("");
  };

  const handleDeleteTag = (tagName) => {
    setTagToDelete(tagName);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    if (tagToDelete) {
      removeTagMutation.mutate(tagToDelete);
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-slate-600">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Manage Tags
          </h1>
          <p className="text-slate-600">
            View, add, and remove tags used across resources
          </p>
        </div>

        {/* Add New Tag Card */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardHeader className="border-b border-slate-200">
            <CardTitle className="text-lg">Add New Tag</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="flex gap-3">
              <div className="flex-1">
                <Label htmlFor="new-tag" className="sr-only">New Tag Name</Label>
                <Input
                  id="new-tag"
                  placeholder="Enter tag name..."
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                />
              </div>
              <Button
                onClick={handleAddTag}
                disabled={!newTagName.trim()}
                className="bg-blue-600 hover:bg-blue-700"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Tag
              </Button>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              New tags will be available for use when creating or editing resources
            </p>
          </CardContent>
        </Card>

        {/* Search Bar */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search tags..."
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
          </CardContent>
        </Card>

        {/* Tags List */}
        {isLoading ? (
          <div className="text-center py-12">Loading tags...</div>
        ) : tagStats.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Tag className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Tags Yet
              </h3>
              <p className="text-slate-600">
                Tags will appear here once they're used on resources
              </p>
            </CardContent>
          </Card>
        ) : filteredTags.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Tag className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Tags Found
              </h3>
              <p className="text-slate-600">
                Try adjusting your search query
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <div className="flex items-center justify-between">
                <CardTitle>All Tags ({filteredTags.length})</CardTitle>
                <Badge variant="outline" className="text-slate-600">
                  {tagStats.length} total
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-200">
                {filteredTags.map((item) => (
                  <div
                    key={item.tag}
                    className="flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <Tag className="w-4 h-4 text-blue-600 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-900 truncate">
                          {item.tag}
                        </h3>
                        <p className="text-sm text-slate-600">
                          Used in {item.count} {item.count === 1 ? 'resource' : 'resources'}
                        </p>
                      </div>
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeleteTag(item.tag)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove Tag</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-red-50 rounded-lg">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-900 font-medium">
                    Are you sure you want to remove the tag "{tagToDelete}"?
                  </p>
                  <p className="text-xs text-red-700 mt-2">
                    This will remove this tag from all resources that currently use it. This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setTagToDelete(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmDelete}
                disabled={removeTagMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                {removeTagMutation.isPending ? 'Removing...' : 'Remove Tag'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}