import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Mail, Plus, Pencil, Trash2, Users, ArrowLeft, Shield, AlertTriangle, Download, Loader2, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useNavigate } from "react-router-dom";

export default function CommunicationsManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [showSetupInstructions, setShowSetupInstructions] = useState(false);

  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('communication')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: categories = [], isLoading: categoriesLoading, error: categoriesError } = useQuery({
    queryKey: ['communication-categories'],
    queryFn: () => base44.entities.CommunicationCategory.list({ sort: { display_order: 'asc' } }),
    staleTime: 0,
    retry: 1,
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
  });

  const { data: categoryRoles = [] } = useQuery({
    queryKey: ['communication-category-roles'],
    queryFn: () => base44.entities.CommunicationCategoryRole.list(),
    staleTime: 0,
    retry: 1,
  });

  const { data: preferences = [] } = useQuery({
    queryKey: ['member-communication-preferences'],
    queryFn: () => base44.entities.MemberCommunicationPreference.list(),
    staleTime: 0,
    retry: 1,
  });

  const { data: allMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['all-members-for-export'],
    queryFn: () => base44.entities.Member.listAll(),
    staleTime: 60000,
  });

  const [exportingCategory, setExportingCategory] = useState(null);
  const [showSubscribersDialog, setShowSubscribersDialog] = useState(false);
  const [viewingCategory, setViewingCategory] = useState(null);
  const [subscribersPage, setSubscribersPage] = useState(1);
  const SUBSCRIBERS_PER_PAGE = 10;

  const getSubscribersForCategory = (categoryId) => {
    const assignedRoleIds = getCategoryRoles(categoryId);
    if (assignedRoleIds.length === 0) return [];
    
    const eligibleMembers = allMembers.filter(member => 
      assignedRoleIds.includes(member.role_id)
    );
    
    const subscribedMemberIds = preferences
      .filter(p => p.category_id === categoryId && p.is_subscribed === true)
      .map(p => p.member_id);
    
    return eligibleMembers.filter(member => subscribedMemberIds.includes(member.id));
  };

  const getSubscriberCount = (categoryId) => {
    return getSubscribersForCategory(categoryId).length;
  };

  const openSubscribersView = (category) => {
    setViewingCategory(category);
    setSubscribersPage(1);
    setShowSubscribersDialog(true);
  };

  const getPaginatedSubscribers = () => {
    if (!viewingCategory) return { subscribers: [], totalPages: 0, total: 0 };
    const allSubscribers = getSubscribersForCategory(viewingCategory.id);
    const total = allSubscribers.length;
    const totalPages = Math.ceil(total / SUBSCRIBERS_PER_PAGE);
    const start = (subscribersPage - 1) * SUBSCRIBERS_PER_PAGE;
    const subscribers = allSubscribers.slice(start, start + SUBSCRIBERS_PER_PAGE);
    return { subscribers, totalPages, total };
  };

  const handleExportSubscribers = async (category) => {
    setExportingCategory(category.id);
    try {
      const subscribers = getSubscribersForCategory(category.id);
      
      if (subscribers.length === 0) {
        toast.info('No subscribers to export for this category');
        setExportingCategory(null);
        return;
      }

      const headers = ['Name', 'Organisation', 'Job Title', 'Email'];
      
      const rows = subscribers.map(member => {
        const name = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'N/A';
        const org = member.organization_name || 'N/A';
        const jobTitle = member.job_title || 'N/A';
        const email = member.email || 'N/A';
        
        return [name, org, jobTitle, email].map(val => {
          const escaped = String(val).replace(/"/g, '""');
          return `"${escaped}"`;
        }).join(',');
      });

      const csvContent = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement('a');
      const safeFileName = category.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const date = new Date().toISOString().split('T')[0];
      link.setAttribute('href', url);
      link.setAttribute('download', `${safeFileName}_subscribers_${date}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      toast.success(`Exported ${subscribers.length} subscribers`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export subscribers');
    } finally {
      setExportingCategory(null);
    }
  };

  const getCategoryRoles = (categoryId) => {
    return categoryRoles.filter(cr => cr.category_id === categoryId).map(cr => cr.role_id);
  };

  const createCategoryMutation = useMutation({
    mutationFn: async (data) => {
      const { selectedRoles, ...categoryData } = data;
      const category = await base44.entities.CommunicationCategory.create(categoryData);
      
      for (const roleId of selectedRoles) {
        await base44.entities.CommunicationCategoryRole.create({
          category_id: category.id,
          role_id: roleId
        });
      }
      return category;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communication-categories'] });
      queryClient.invalidateQueries({ queryKey: ['communication-category-roles'] });
      setShowCategoryDialog(false);
      setEditingCategory(null);
      toast.success('Category created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create category: ' + error.message);
    }
  });

  const updateCategoryMutation = useMutation({
    mutationFn: async ({ id, data }) => {
      const { selectedRoles, ...categoryData } = data;
      await base44.entities.CommunicationCategory.update(id, categoryData);
      
      const existingRoles = categoryRoles.filter(cr => cr.category_id === id);
      for (const existing of existingRoles) {
        if (!selectedRoles.includes(existing.role_id)) {
          await base44.entities.CommunicationCategoryRole.delete(existing.id);
        }
      }
      
      const existingRoleIds = existingRoles.map(er => er.role_id);
      for (const roleId of selectedRoles) {
        if (!existingRoleIds.includes(roleId)) {
          await base44.entities.CommunicationCategoryRole.create({
            category_id: id,
            role_id: roleId
          });
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communication-categories'] });
      queryClient.invalidateQueries({ queryKey: ['communication-category-roles'] });
      setShowCategoryDialog(false);
      setEditingCategory(null);
      toast.success('Category updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update category: ' + error.message);
    }
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: async (id) => {
      const relatedRoles = categoryRoles.filter(cr => cr.category_id === id);
      for (const cr of relatedRoles) {
        await base44.entities.CommunicationCategoryRole.delete(cr.id);
      }
      await base44.entities.CommunicationCategory.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['communication-categories'] });
      queryClient.invalidateQueries({ queryKey: ['communication-category-roles'] });
      setShowDeleteConfirm(false);
      setCategoryToDelete(null);
      toast.success('Category deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete category: ' + error.message);
    }
  });

  const handleSaveCategory = () => {
    if (!editingCategory.name?.trim()) {
      toast.error('Please enter a category name');
      return;
    }
    if (!editingCategory.selectedRoles || editingCategory.selectedRoles.length === 0) {
      toast.error('Please select at least one role');
      return;
    }

    if (editingCategory.id) {
      updateCategoryMutation.mutate({ id: editingCategory.id, data: editingCategory });
    } else {
      createCategoryMutation.mutate(editingCategory);
    }
  };

  const openNewCategoryDialog = () => {
    setEditingCategory({
      name: '',
      description: '',
      is_active: true,
      display_order: categories.length,
      selectedRoles: []
    });
    setShowCategoryDialog(true);
  };

  const openEditCategoryDialog = (category) => {
    setEditingCategory({
      ...category,
      selectedRoles: getCategoryRoles(category.id)
    });
    setShowCategoryDialog(true);
  };

  const toggleRoleSelection = (roleId) => {
    const currentRoles = editingCategory.selectedRoles || [];
    if (currentRoles.includes(roleId)) {
      setEditingCategory({
        ...editingCategory,
        selectedRoles: currentRoles.filter(id => id !== roleId)
      });
    } else {
      setEditingCategory({
        ...editingCategory,
        selectedRoles: [...currentRoles, roleId]
      });
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const tablesNotSetup = categoriesError?.message?.includes('does not exist') || 
                         categoriesError?.message?.includes('relation') ||
                         categoriesError?.message?.includes('42P01');

  if (tablesNotSetup) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <Button
            variant="ghost"
            onClick={() => navigate(createPageUrl('RoleManagement'))}
            className="mb-6"
            data-testid="button-back-to-roles"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Role Management
          </Button>

          <Card className="border-amber-200 bg-amber-50">
            <CardHeader>
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-8 h-8 text-amber-600" />
                <div>
                  <CardTitle className="text-amber-900">Database Setup Required</CardTitle>
                  <CardDescription className="text-amber-700">
                    The communications tables need to be created in Supabase before using this feature.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-amber-800 mb-4">
                Please run the following SQL in your Supabase SQL Editor to create the required tables:
              </p>
              <pre className="bg-slate-900 text-green-400 p-4 rounded-lg text-xs overflow-x-auto whitespace-pre-wrap">
{`-- Communication Categories
CREATE TABLE IF NOT EXISTS communication_category (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Role assignments for each category
CREATE TABLE IF NOT EXISTS communication_category_role (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES communication_category(id) ON DELETE CASCADE,
  role_id UUID REFERENCES role(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(category_id, role_id)
);

-- Member preferences for categories
CREATE TABLE IF NOT EXISTS member_communication_preference (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES member(id) ON DELETE CASCADE,
  category_id UUID REFERENCES communication_category(id) ON DELETE CASCADE,
  is_subscribed BOOLEAN DEFAULT true,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(member_id, category_id)
);

-- Enable RLS
ALTER TABLE communication_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_category_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_communication_preference ENABLE ROW LEVEL SECURITY;

-- Policies for service role access
CREATE POLICY "Service role has full access to communication_category" 
  ON communication_category FOR ALL 
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to communication_category_role" 
  ON communication_category_role FOR ALL 
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to member_communication_preference" 
  ON member_communication_preference FOR ALL 
  USING (true) WITH CHECK (true);`}
              </pre>
              <Button 
                onClick={() => window.location.reload()} 
                className="mt-4 bg-amber-600 hover:bg-amber-700"
                data-testid="button-refresh-after-setup"
              >
                Refresh After Setup
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <Button
          variant="ghost"
          onClick={() => navigate(createPageUrl('RoleManagement'))}
          className="mb-6"
          data-testid="button-back-to-roles"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Role Management
        </Button>

        <Card className="shadow-lg border-0">
          <CardHeader className="border-b border-slate-200 bg-white rounded-t-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Mail className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <CardTitle className="text-xl">Communications Management</CardTitle>
                  <CardDescription>
                    Manage marketing communication categories and role-based subscriptions
                  </CardDescription>
                </div>
              </div>
              <Button 
                onClick={openNewCategoryDialog}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-add-category"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Category
              </Button>
            </div>
          </CardHeader>

          <CardContent className="p-6">
            {categoriesLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-pulse text-slate-600">Loading categories...</div>
              </div>
            ) : categories.length === 0 ? (
              <div className="text-center py-12">
                <Mail className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-slate-900 mb-2">No Communication Categories</h3>
                <p className="text-slate-600 mb-4">
                  Create categories like "Newsletter", "Events", "Offers" etc. to manage member subscriptions.
                </p>
                <Button 
                  onClick={openNewCategoryDialog}
                  className="bg-blue-600 hover:bg-blue-700"
                  data-testid="button-add-first-category"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Category
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {categories.map((category) => {
                  const assignedRoles = getCategoryRoles(category.id);
                  const subscriberCount = getSubscriberCount(category.id);
                  
                  return (
                    <Card 
                      key={category.id} 
                      className={`border ${category.is_active ? 'border-slate-200' : 'border-slate-200 bg-slate-50'}`}
                      data-testid={`card-category-${category.id}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-3 mb-2">
                              <h3 className="text-lg font-semibold text-slate-900">
                                {category.name}
                              </h3>
                              {!category.is_active && (
                                <Badge variant="secondary" className="text-xs">
                                  Inactive
                                </Badge>
                              )}
                            </div>
                            
                            {category.description && (
                              <p className="text-sm text-slate-600 mb-3">
                                {category.description}
                              </p>
                            )}
                            
                            <div className="flex flex-wrap items-center gap-4">
                              <div className="flex items-center gap-2">
                                <Shield className="w-4 h-4 text-slate-400" />
                                <span className="text-sm text-slate-600">Roles:</span>
                                <div className="flex flex-wrap gap-1">
                                  {assignedRoles.length === 0 ? (
                                    <span className="text-sm text-slate-400 italic">None assigned</span>
                                  ) : (
                                    assignedRoles.map(roleId => {
                                      const role = roles.find(r => r.id === roleId);
                                      return role ? (
                                        <Badge 
                                          key={roleId} 
                                          variant="outline" 
                                          className="text-xs"
                                        >
                                          {role.name}
                                        </Badge>
                                      ) : null;
                                    })
                                  )}
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-2">
                                <Users className="w-4 h-4 text-slate-400" />
                                <button
                                  className="text-sm text-slate-600 hover:text-blue-600 hover:underline cursor-pointer bg-transparent border-0 p-0"
                                  onClick={() => openSubscribersView(category)}
                                  disabled={membersLoading}
                                  title={membersLoading ? 'Loading members...' : 'View subscribers'}
                                  data-testid={`button-view-subscribers-${category.id}`}
                                >
                                  <span className="font-medium text-slate-900 hover:text-blue-600">{subscriberCount}</span> subscribers
                                </button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                                  onClick={() => handleExportSubscribers(category)}
                                  disabled={exportingCategory === category.id || subscriberCount === 0 || membersLoading}
                                  title={membersLoading ? 'Loading members...' : subscriberCount === 0 ? 'No subscribers to export' : 'Export subscribers to CSV'}
                                  data-testid={`button-export-category-${category.id}`}
                                >
                                  {exportingCategory === category.id || membersLoading ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <Download className="w-4 h-4" />
                                  )}
                                </Button>
                              </div>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-2 ml-4">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEditCategoryDialog(category)}
                              data-testid={`button-edit-category-${category.id}`}
                            >
                              <Pencil className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              onClick={() => {
                                setCategoryToDelete(category);
                                setShowDeleteConfirm(true);
                              }}
                              data-testid={`button-delete-category-${category.id}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
          <DialogContent className="max-w-lg" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>
                {editingCategory?.id ? 'Edit Category' : 'Create Category'}
              </DialogTitle>
            </DialogHeader>
            
            {editingCategory && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Category Name *</Label>
                  <Input
                    id="name"
                    value={editingCategory.name || ''}
                    onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })}
                    placeholder="e.g., Newsletter, Events, Special Offers"
                    data-testid="input-category-name"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={editingCategory.description || ''}
                    onChange={(e) => setEditingCategory({ ...editingCategory, description: e.target.value })}
                    placeholder="Describe what communications this category includes"
                    rows={2}
                    data-testid="input-category-description"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>Applicable Roles *</Label>
                  <p className="text-xs text-slate-500 mb-2">
                    Select which roles can subscribe to this category
                  </p>
                  <div className="border border-slate-200 rounded-lg p-3 max-h-48 overflow-y-auto space-y-2">
                    {roles.filter(r => r.is_active !== false).map(role => (
                      <div 
                        key={role.id} 
                        className="flex items-center gap-3 p-2 hover:bg-slate-50 rounded"
                      >
                        <Checkbox
                          id={`role-${role.id}`}
                          checked={editingCategory.selectedRoles?.includes(role.id)}
                          onCheckedChange={() => toggleRoleSelection(role.id)}
                          data-testid={`checkbox-role-${role.id}`}
                        />
                        <Label 
                          htmlFor={`role-${role.id}`} 
                          className="flex-1 cursor-pointer text-sm"
                        >
                          {role.name}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
                
                <div className="flex items-center gap-3">
                  <Switch
                    id="is_active"
                    checked={editingCategory.is_active}
                    onCheckedChange={(checked) => setEditingCategory({ ...editingCategory, is_active: checked })}
                    data-testid="switch-category-active"
                  />
                  <Label htmlFor="is_active" className="cursor-pointer">
                    Active
                  </Label>
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="display_order">Display Order</Label>
                  <Input
                    id="display_order"
                    type="number"
                    value={editingCategory.display_order ?? 0}
                    onChange={(e) => setEditingCategory({ ...editingCategory, display_order: parseInt(e.target.value) || 0 })}
                    data-testid="input-category-order"
                  />
                </div>
              </div>
            )}
            
            <DialogFooter>
              <Button 
                variant="outline" 
                onClick={() => setShowCategoryDialog(false)}
                data-testid="button-cancel-category"
              >
                Cancel
              </Button>
              <Button 
                onClick={handleSaveCategory}
                disabled={createCategoryMutation.isPending || updateCategoryMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-category"
              >
                {editingCategory?.id ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent aria-describedby="delete-category-description">
            <DialogHeader>
              <DialogTitle>Delete Category</DialogTitle>
              <DialogDescription id="delete-category-description">
                Are you sure you want to delete "{categoryToDelete?.name}"? This will also remove all member preferences for this category.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button 
                variant="outline" 
                onClick={() => setShowDeleteConfirm(false)}
                data-testid="button-cancel-delete"
              >
                Cancel
              </Button>
              <Button 
                variant="destructive"
                onClick={() => deleteCategoryMutation.mutate(categoryToDelete?.id)}
                disabled={deleteCategoryMutation.isPending}
                data-testid="button-confirm-delete"
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showSubscribersDialog} onOpenChange={setShowSubscribersDialog}>
          <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col" aria-describedby="subscribers-dialog-description">
            <DialogHeader className="flex-shrink-0">
              <div className="flex items-center justify-between">
                <div>
                  <DialogTitle className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-blue-600" />
                    {viewingCategory?.name} Subscribers
                  </DialogTitle>
                  <DialogDescription id="subscribers-dialog-description" className="mt-1">
                    {(() => {
                      const { total } = getPaginatedSubscribers();
                      return `${total} member${total !== 1 ? 's' : ''} subscribed to this category`;
                    })()}
                  </DialogDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => viewingCategory && handleExportSubscribers(viewingCategory)}
                  disabled={exportingCategory === viewingCategory?.id || membersLoading}
                  className="flex items-center gap-2"
                  data-testid="button-export-from-dialog"
                >
                  {exportingCategory === viewingCategory?.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  Export CSV
                </Button>
              </div>
            </DialogHeader>
            
            <div className="flex-1 overflow-auto mt-4">
              {membersLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600 mr-2" />
                  <span className="text-slate-600">Loading members...</span>
                </div>
              ) : (
                <>
                  {(() => {
                    const { subscribers, totalPages, total } = getPaginatedSubscribers();
                    
                    if (total === 0) {
                      return (
                        <div className="text-center py-12">
                          <Users className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                          <p className="text-slate-600">No subscribers for this category</p>
                        </div>
                      );
                    }
                    
                    return (
                      <>
                        <p className="text-xs text-slate-500 mb-3">Click on a member to edit their details</p>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Name</TableHead>
                              <TableHead>Organisation</TableHead>
                              <TableHead>Job Title</TableHead>
                              <TableHead>Email</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {subscribers.map((member) => (
                              <TableRow 
                                key={member.id} 
                                data-testid={`row-subscriber-${member.id}`}
                                className="cursor-pointer hover:bg-blue-50 transition-colors"
                                onClick={() => {
                                  setShowSubscribersDialog(false);
                                  navigate(`/AdminMemberEdit?id=${member.id}`);
                                }}
                              >
                                <TableCell className="font-medium text-blue-600 hover:text-blue-700">
                                  {[member.first_name, member.last_name].filter(Boolean).join(' ') || 'N/A'}
                                </TableCell>
                                <TableCell>{member.organization_name || 'N/A'}</TableCell>
                                <TableCell>{member.job_title || 'N/A'}</TableCell>
                                <TableCell className="text-slate-600">{member.email || 'N/A'}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        
                        {totalPages > 1 && (
                          <div className="flex items-center justify-between mt-4 pt-4 border-t">
                            <div className="text-sm text-slate-600">
                              Showing {((subscribersPage - 1) * SUBSCRIBERS_PER_PAGE) + 1} - {Math.min(subscribersPage * SUBSCRIBERS_PER_PAGE, total)} of {total}
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setSubscribersPage(p => Math.max(1, p - 1))}
                                disabled={subscribersPage === 1}
                                data-testid="button-prev-page"
                              >
                                <ChevronLeft className="w-4 h-4" />
                                Previous
                              </Button>
                              <span className="text-sm text-slate-600 px-2">
                                Page {subscribersPage} of {totalPages}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setSubscribersPage(p => Math.min(totalPages, p + 1))}
                                disabled={subscribersPage === totalPages}
                                data-testid="button-next-page"
                              >
                                Next
                                <ChevronRight className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
