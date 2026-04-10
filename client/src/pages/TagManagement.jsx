import { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tag, Trash2, AlertCircle, Search, X, FileText, BookOpen, Building2, Users, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { useTagColors, TAG_COLOR_PALETTE } from "@/hooks/useTagColors";

function ColorPicker({ selectedColor, onSelect, palette }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="color-picker-manage">
      {palette.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onSelect(color)}
          className={`w-6 h-6 rounded-full border-2 transition-transform ${
            selectedColor === color
              ? "border-slate-900 dark:border-white scale-110"
              : "border-transparent hover:scale-110"
          }`}
          style={{ backgroundColor: color }}
          data-testid={`manage-color-swatch-${color.replace("#", "")}`}
        />
      ))}
      {selectedColor && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="w-6 h-6 rounded-full border-2 border-dashed border-slate-300 flex items-center justify-center text-slate-400 hover:scale-110 transition-transform"
          data-testid="manage-color-swatch-clear"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

export default function TagManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [resourceSearchQuery, setResourceSearchQuery] = useState("");
  const [articleSearchQuery, setArticleSearchQuery] = useState("");
  const [orgSearchQuery, setOrgSearchQuery] = useState("");
  const [memberSearchQuery, setMemberSearchQuery] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [tagToDelete, setTagToDelete] = useState(null);
  const [deleteType, setDeleteType] = useState(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [tagToRename, setTagToRename] = useState(null);
  const [renameType, setRenameType] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameColor, setRenameColor] = useState(null);

  const queryClient = useQueryClient();

  const orgTagColors = useTagColors("organization");
  const memberTagColors = useTagColors("member");

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

  const { data: organizations = [], isLoading: orgsLoading } = useQuery({
    queryKey: ['admin-organizations-tags'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ['admin-members-tags'],
    queryFn: () => base44.entities.Member.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const buildTagStats = (items) => {
    const tagMap = new Map();
    items.forEach(item => {
      if (item.tags && Array.isArray(item.tags)) {
        item.tags.forEach(tag => {
          if (tagMap.has(tag)) {
            tagMap.set(tag, {
              count: tagMap.get(tag).count + 1,
              ids: [...tagMap.get(tag).ids, item.id]
            });
          } else {
            tagMap.set(tag, { count: 1, ids: [item.id] });
          }
        });
      }
    });
    return Array.from(tagMap.entries())
      .map(([tag, data]) => ({ tag, ...data }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
  };

  const resourceTagStats = useMemo(() => buildTagStats(resources), [resources]);
  const articleTagStats = useMemo(() => buildTagStats(articles), [articles]);
  const orgTagStats = useMemo(() => buildTagStats(organizations), [organizations]);
  const memberTagStats = useMemo(() => buildTagStats(members), [members]);

  const filterTags = (tagStats, query) => {
    if (!query.trim()) return tagStats;
    const searchLower = query.toLowerCase();
    return tagStats.filter(item => item.tag.toLowerCase().includes(searchLower));
  };

  const filteredResourceTags = useMemo(() => filterTags(resourceTagStats, resourceSearchQuery), [resourceTagStats, resourceSearchQuery]);
  const filteredArticleTags = useMemo(() => filterTags(articleTagStats, articleSearchQuery), [articleTagStats, articleSearchQuery]);
  const filteredOrgTags = useMemo(() => filterTags(orgTagStats, orgSearchQuery), [orgTagStats, orgSearchQuery]);
  const filteredMemberTags = useMemo(() => filterTags(memberTagStats, memberSearchQuery), [memberTagStats, memberSearchQuery]);

  const entityMap = {
    resource: { entity: base44.entities.Resource, items: resources, queryKey: 'admin-resources', label: 'resources' },
    article: { entity: base44.entities.BlogPost, items: articles, queryKey: 'admin-articles', label: articleDisplayName.toLowerCase() },
    organization: { entity: base44.entities.Organization, items: organizations, queryKey: 'admin-organizations-tags', label: 'organisations' },
    member: { entity: base44.entities.Member, items: members, queryKey: 'admin-members-tags', label: 'members' },
  };

  const getTagColorsHook = (type) => {
    if (type === "organization") return orgTagColors;
    if (type === "member") return memberTagColors;
    return null;
  };

  const deleteTagMutation = useMutation({
    mutationFn: async ({ tagName, type }) => {
      const config = entityMap[type];
      const itemsToUpdate = config.items.filter(item =>
        item.tags && item.tags.includes(tagName)
      );
      await Promise.all(
        itemsToUpdate.map(item =>
          config.entity.update(item.id, {
            ...item,
            tags: item.tags.filter(t => t !== tagName)
          })
        )
      );
      let colorWarning = false;
      const colorsHook = getTagColorsHook(type);
      if (colorsHook) {
        try {
          await colorsHook.removeTagColor(tagName);
        } catch (err) {
          console.error("Failed to remove tag color:", err);
          colorWarning = true;
        }
      }
      return { type, colorWarning };
    },
    onSuccess: ({ colorWarning }, { type }) => {
      const config = entityMap[type];
      queryClient.invalidateQueries({ queryKey: [config.queryKey] });
      if (type === 'member') {
        queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
        queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'member-direct' });
      }
      if (type === 'organization') {
        queryClient.invalidateQueries({ queryKey: ['organizations-crm-list'] });
      }
      setShowDeleteConfirm(false);
      setTagToDelete(null);
      setDeleteType(null);
      toast.success(`Tag removed from all ${entityMap[type].label}`);
      if (colorWarning) {
        toast.warning('Tag colour record could not be removed.');
      }
    },
    onError: (error) => {
      toast.error('Failed to remove tag: ' + error.message);
    }
  });

  const renameTagMutation = useMutation({
    mutationFn: async ({ oldName, newName, type, color }) => {
      const config = entityMap[type];
      const itemsToUpdate = config.items.filter(item =>
        item.tags && item.tags.includes(oldName)
      );
      await Promise.all(
        itemsToUpdate.map(item => {
          const updatedTags = [...new Set(item.tags.map(t => t === oldName ? newName : t))];
          return config.entity.update(item.id, {
            ...item,
            tags: updatedTags
          });
        })
      );
      let colorWarning = false;
      const colorsHook = getTagColorsHook(type);
      if (colorsHook) {
        try {
          if (oldName !== newName) {
            await colorsHook.renameTagColor(oldName, newName);
          }
          if (color) {
            await colorsHook.setTagColor(newName, color);
          } else if (color === null) {
            await colorsHook.removeTagColor(newName);
          }
        } catch (err) {
          console.error("Failed to update tag color:", err);
          colorWarning = true;
        }
      }
      return { type, colorWarning };
    },
    onSuccess: ({ colorWarning }, { type }) => {
      const config = entityMap[type];
      queryClient.invalidateQueries({ queryKey: [config.queryKey] });
      queryClient.invalidateQueries({ queryKey: ['crm-tag-colors', type] });
      if (type === 'member') {
        queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
        queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'member-direct' });
      }
      if (type === 'organization') {
        queryClient.invalidateQueries({ queryKey: ['organizations-crm-list'] });
      }
      setShowRenameDialog(false);
      setTagToRename(null);
      setRenameType(null);
      setRenameValue("");
      setRenameColor(null);
      toast.success('Tag updated successfully');
      if (colorWarning) {
        toast.warning('Tag colour could not be updated.');
      }
    },
    onError: (error) => {
      toast.error('Failed to update tag: ' + error.message);
    }
  });

  const handleDeleteTag = (tagName, type) => {
    setTagToDelete(tagName);
    setDeleteType(type);
    setShowDeleteConfirm(true);
  };

  const handleRenameTag = (tagName, type) => {
    setTagToRename(tagName);
    setRenameType(type);
    setRenameValue(tagName);
    const colorsHook = getTagColorsHook(type);
    setRenameColor(colorsHook ? colorsHook.getTagColor(tagName) : null);
    setShowRenameDialog(true);
  };

  const confirmDelete = () => {
    if (tagToDelete && deleteType) {
      deleteTagMutation.mutate({ tagName: tagToDelete, type: deleteType });
    }
  };

  const confirmRename = () => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      toast.error('Tag name cannot be empty');
      return;
    }
    const colorsHook = getTagColorsHook(renameType);
    const currentColor = colorsHook ? colorsHook.getTagColor(tagToRename) : null;
    const colorChanged = renameColor !== currentColor;
    const nameChanged = trimmed !== tagToRename;

    if (!nameChanged && !colorChanged) {
      setShowRenameDialog(false);
      return;
    }
    if (tagToRename && renameType) {
      const statsMap = { resource: resourceTagStats, article: articleTagStats, organization: orgTagStats, member: memberTagStats };
      const existingTags = statsMap[renameType] || [];
      if (nameChanged) {
        const duplicateExists = existingTags.some(t => t.tag.toLowerCase() === trimmed.toLowerCase() && t.tag !== tagToRename);
        if (duplicateExists) {
          toast.info(`A tag "${trimmed}" already exists on some records. Tags will be merged.`);
        }
      }
      renameTagMutation.mutate({
        oldName: tagToRename,
        newName: nameChanged ? trimmed : tagToRename,
        type: renameType,
        color: colorChanged ? renameColor : undefined,
      });
    }
  };

  const isDeleting = deleteTagMutation.isPending;
  const isRenaming = renameTagMutation.isPending;

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

  const renderTagList = (tags, type, isLoading, searchQuery, setSearchQuery, entityName, entityNamePlural, Icon) => {
    const colorsHook = getTagColorsHook(type);

    return (
      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-blue-600" />
            <CardTitle className="text-lg">{entityNamePlural} Tags</CardTitle>
            <Badge variant="outline" className="ml-auto no-default-hover-elevate no-default-active-elevate">
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
              {tags.map((item) => {
                const tagColor = colorsHook ? colorsHook.getTagColor(item.tag) : null;
                const tagStyle = colorsHook ? colorsHook.getTagStyle(item.tag) : {};
                return (
                  <div
                    key={item.tag}
                    className="flex items-center justify-between py-3 hover:bg-slate-50 px-2 rounded transition-colors"
                    data-testid={`tag-${type}-${item.tag}`}
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {tagColor ? (
                        <span
                          className="w-4 h-4 rounded-full shrink-0 border border-slate-200"
                          style={{ backgroundColor: tagColor }}
                        />
                      ) : (
                        <Tag className="w-4 h-4 text-blue-600 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge
                            variant="secondary"
                            className="text-xs no-default-hover-elevate no-default-active-elevate"
                            style={tagColor ? tagStyle : undefined}
                          >
                            {item.tag}
                          </Badge>
                        </div>
                        <span className="text-xs text-slate-500">
                          {item.count} {item.count === 1 ? entityName.toLowerCase() : entityNamePlural.toLowerCase()}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRenameTag(item.tag, type)}
                        data-testid={`button-rename-${type}-tag-${item.tag}`}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteTag(item.tag, type)}
                        className="text-red-600"
                        data-testid={`button-delete-${type}-tag-${item.tag}`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Manage Tags
          </h1>
          <p className="text-slate-600">
            View and manage tags used across resources, {articleDisplayName.toLowerCase()}, organisations, and members
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

          {renderTagList(
            filteredOrgTags,
            'organization',
            orgsLoading,
            orgSearchQuery,
            setOrgSearchQuery,
            'Organisation',
            'Organisations',
            Building2
          )}

          {renderTagList(
            filteredMemberTags,
            'member',
            membersLoading,
            memberSearchQuery,
            setMemberSearchQuery,
            'Member',
            'Members',
            Users
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
                    This will remove this tag from all {deleteType ? entityMap[deleteType]?.label : 'records'} that currently use it. This action cannot be undone.
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

        <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Edit Tag</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <p className="text-sm text-slate-600 mb-2">
                  Renaming "{tagToRename}" will update it across all {renameType ? entityMap[renameType]?.label : 'records'} that use this tag.
                </p>
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="Enter new tag name"
                  data-testid="input-rename-tag"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      confirmRename();
                    }
                  }}
                />
              </div>
              {(renameType === "organization" || renameType === "member") && (
                <div>
                  <p className="text-sm text-slate-600 mb-2">Tag colour:</p>
                  <ColorPicker
                    selectedColor={renameColor}
                    onSelect={(c) => setRenameColor(c)}
                    palette={TAG_COLOR_PALETTE}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowRenameDialog(false);
                  setTagToRename(null);
                  setRenameType(null);
                  setRenameValue("");
                  setRenameColor(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={confirmRename}
                disabled={isRenaming || !renameValue.trim()}
                data-testid="button-confirm-rename-tag"
              >
                {isRenaming ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
