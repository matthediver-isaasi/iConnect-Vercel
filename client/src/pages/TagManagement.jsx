import { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tag, Trash2, AlertCircle, Search, X, FileText, BookOpen } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function TagManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [resourceSearchQuery, setResourceSearchQuery] = useState("");
  const [articleSearchQuery, setArticleSearchQuery] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tagToDelete, setTagToDelete] = useState(null);
  const [deleteType, setDeleteType] = useState(null);

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

  const { data: articleDisplayName = 'Articles' } = useQuery({
    queryKey: ['article-display-name'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'article_display_name');
      return setting?.setting_value || 'Articles';
    },
    staleTime: 5 * 60 * 1000,
  });

  const singularArticleName = articleDisplayName.endsWith('s') 
    ? articleDisplayName.slice(0, -1) 
    : articleDisplayName;

  const { data: resources = [], isLoading: resourcesLoading } = useQuery({
    queryKey: ['admin-resources'],
    queryFn: () => base44.entities.Resource.list('-release_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: articles = [], isLoading: articlesLoading } = useQuery({
    queryKey: ['admin-articles'],
    queryFn: () => base44.entities.BlogPost.list('-published_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const resourceTagStats = useMemo(() => {
    const tagMap = new Map();
    
    resources.forEach(resource => {
      if (resource.tags && Array.isArray(resource.tags)) {
        resource.tags.forEach(tag => {
          if (tagMap.has(tag)) {
            tagMap.set(tag, {
              count: tagMap.get(tag).count + 1,
              ids: [...tagMap.get(tag).ids, resource.id]
            });
          } else {
            tagMap.set(tag, {
              count: 1,
              ids: [resource.id]
            });
          }
        });
      }
    });

    return Array.from(tagMap.entries())
      .map(([tag, data]) => ({ tag, ...data }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [resources]);

  const articleTagStats = useMemo(() => {
    const tagMap = new Map();
    
    articles.forEach(article => {
      if (article.tags && Array.isArray(article.tags)) {
        article.tags.forEach(tag => {
          if (tagMap.has(tag)) {
            tagMap.set(tag, {
              count: tagMap.get(tag).count + 1,
              ids: [...tagMap.get(tag).ids, article.id]
            });
          } else {
            tagMap.set(tag, {
              count: 1,
              ids: [article.id]
            });
          }
        });
      }
    });

    return Array.from(tagMap.entries())
      .map(([tag, data]) => ({ tag, ...data }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  }, [articles]);

  const filteredResourceTags = useMemo(() => {
    if (!resourceSearchQuery.trim()) return resourceTagStats;
    const searchLower = resourceSearchQuery.toLowerCase();
    return resourceTagStats.filter(item => item.tag.toLowerCase().includes(searchLower));
  }, [resourceTagStats, resourceSearchQuery]);

  const filteredArticleTags = useMemo(() => {
    if (!articleSearchQuery.trim()) return articleTagStats;
    const searchLower = articleSearchQuery.toLowerCase();
    return articleTagStats.filter(item => item.tag.toLowerCase().includes(searchLower));
  }, [articleTagStats, articleSearchQuery]);

  const removeResourceTagMutation = useMutation({
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
      setDeleteType(null);
      toast.success('Tag removed from all resources');
    },
    onError: (error) => {
      toast.error('Failed to remove tag: ' + error.message);
    }
  });

  const removeArticleTagMutation = useMutation({
    mutationFn: async (tagToRemove) => {
      const articlesToUpdate = articles.filter(a => 
        a.tags && a.tags.includes(tagToRemove)
      );

      await Promise.all(
        articlesToUpdate.map(article =>
          base44.entities.BlogPost.update(article.id, {
            ...article,
            tags: article.tags.filter(t => t !== tagToRemove)
          })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
      setShowDeleteConfirm(false);
      setTagToDelete(null);
      setDeleteType(null);
      toast.success(`Tag removed from all ${articleDisplayName.toLowerCase()}`);
    },
    onError: (error) => {
      toast.error('Failed to remove tag: ' + error.message);
    }
  });

  const handleDeleteTag = (tagName, type) => {
    setTagToDelete(tagName);
    setDeleteType(type);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    if (tagToDelete) {
      if (deleteType === 'resource') {
        removeResourceTagMutation.mutate(tagToDelete);
      } else {
        removeArticleTagMutation.mutate(tagToDelete);
      }
    }
  };

  const isDeleting = removeResourceTagMutation.isPending || removeArticleTagMutation.isPending;

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

  const renderTagList = (tags, type, isLoading, searchQuery, setSearchQuery, entityName, entityNamePlural, Icon) => (
    <Card className="border-slate-200 shadow-sm">
      <CardHeader className="border-b border-slate-200">
        <div className="flex items-center gap-2">
          <Icon className="w-5 h-5 text-blue-600" />
          <CardTitle className="text-lg">{entityNamePlural} Tags</CardTitle>
          <Badge variant="outline" className="ml-auto">
            {tags.length} tags
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-4">
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder={`Search ${entityNamePlural.toLowerCase()} tags...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 pr-10"
            data-testid={`input-search-${type}-tags`}
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

        {isLoading ? (
          <div className="text-center py-8 text-slate-500">Loading tags...</div>
        ) : tags.length === 0 ? (
          <div className="text-center py-8">
            <Tag className="w-12 h-12 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-600">
              No tags yet. Tags will appear here when used on {entityNamePlural.toLowerCase()}.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200 max-h-96 overflow-y-auto">
            {tags.map((item) => (
              <div
                key={item.tag}
                className="flex items-center justify-between py-3 hover:bg-slate-50 px-2 rounded transition-colors"
                data-testid={`tag-${type}-${item.tag}`}
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Tag className="w-4 h-4 text-blue-600 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-slate-900 truncate block">
                      {item.tag}
                    </span>
                    <span className="text-xs text-slate-500">
                      {item.count} {item.count === 1 ? entityName.toLowerCase() : entityNamePlural.toLowerCase()}
                    </span>
                  </div>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteTag(item.tag, type)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  data-testid={`button-delete-${type}-tag-${item.tag}`}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Manage Tags
          </h1>
          <p className="text-slate-600">
            View and manage tags used across resources and {articleDisplayName.toLowerCase()}
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {renderTagList(
            filteredResourceTags,
            'resource',
            resourcesLoading,
            resourceSearchQuery,
            setResourceSearchQuery,
            'Resource',
            'Resources',
            FileText
          )}

          {renderTagList(
            filteredArticleTags,
            'article',
            articlesLoading,
            articleSearchQuery,
            setArticleSearchQuery,
            singularArticleName,
            articleDisplayName,
            BookOpen
          )}
        </div>

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
                    This will remove this tag from all {deleteType === 'resource' ? 'resources' : articleDisplayName.toLowerCase()} that currently use it. This action cannot be undone.
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
                  setDeleteType(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmDelete}
                disabled={isDeleting}
                className="bg-red-600 hover:bg-red-700"
              >
                {isDeleting ? 'Removing...' : 'Remove Tag'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
