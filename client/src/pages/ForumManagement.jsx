import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MessageSquare, Plus, Pencil, Trash2, Shield, AlertTriangle, Loader2, Database, Eye, CheckCircle, XCircle, Clock, FileText, ArrowUpDown } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import EventImageUpload from "@/components/events/EventImageUpload";
import { FocalPointPicker } from "@/components/FocalPointPicker";

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export default function ForumManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [activeTab, setActiveTab] = useState("categories");

  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState(null);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [categoryForm, setCategoryForm] = useState({
    name: '',
    description: '',
    slug: '',
    display_order: 0,
    is_active: true,
    group_id: '',
    icon: '',
    header_image_url: '',
    header_image_focal_point: { x: 50, y: 50 }
  });

  const [reportStatusFilter, setReportStatusFilter] = useState('all');
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [selectedReport, setSelectedReport] = useState(null);
  const [resolutionNote, setResolutionNote] = useState('');
  const [showModLog, setShowModLog] = useState(false);

  const [initializingTables, setInitializingTables] = useState(false);
  const [initResult, setInitResult] = useState(null);

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('forum.management')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: categories = [], isLoading: categoriesLoading, error: categoriesError } = useQuery({
    queryKey: ['forum-categories'],
    queryFn: () => base44.entities.ForumCategory.list({ sort: { display_order: 'asc' } }),
    staleTime: 0,
    retry: 1,
  });

  const { data: threads = [] } = useQuery({
    queryKey: ['forum-threads'],
    queryFn: () => base44.entities.ForumThread.list(),
    staleTime: 0,
    retry: 1,
    enabled: !categoriesError,
  });

  const { data: memberGroups = [] } = useQuery({
    queryKey: ['member-groups-for-forum'],
    queryFn: () => base44.entities.MemberGroup.list(),
  });

  const { data: reports = [], isLoading: reportsLoading } = useQuery({
    queryKey: ['forum-reports'],
    queryFn: () => base44.entities.ForumReport.list(),
    staleTime: 0,
    retry: 1,
    enabled: activeTab === 'moderation' && !categoriesError,
  });

  const { data: moderationLogs = [], isLoading: modLogsLoading } = useQuery({
    queryKey: ['forum-moderation-logs'],
    queryFn: () => base44.entities.ForumModerationLog.list(),
    staleTime: 0,
    retry: 1,
    enabled: showModLog && !categoriesError,
  });

  const { data: members = [] } = useQuery({
    queryKey: ['members-for-forum'],
    queryFn: () => base44.entities.Member.list({ limit: 5000 }),
    staleTime: 60000,
    enabled: activeTab === 'moderation',
  });

  const tablesNotReady = categoriesError && (
    categoriesError.message?.includes('42P01') ||
    categoriesError.message?.includes('does not exist') ||
    categoriesError.message?.includes('relation') ||
    categoriesError.message?.includes('500')
  );

  const threadCountByCategory = useMemo(() => {
    const counts = {};
    threads.forEach(t => {
      counts[t.category_id] = (counts[t.category_id] || 0) + 1;
    });
    return counts;
  }, [threads]);

  const membersMap = useMemo(() => {
    const map = {};
    members.forEach(m => {
      map[m.id] = m;
    });
    return map;
  }, [members]);

  const groupsMap = useMemo(() => {
    const map = {};
    memberGroups.forEach(g => {
      map[g.id] = g;
    });
    return map;
  }, [memberGroups]);

  const filteredReports = useMemo(() => {
    if (reportStatusFilter === 'all') return reports;
    return reports.filter(r => r.status === reportStatusFilter);
  }, [reports, reportStatusFilter]);

  const createCategoryMutation = useMutation({
    mutationFn: (data) => base44.entities.ForumCategory.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forum-categories'] });
      setShowCategoryDialog(false);
      resetCategoryForm();
      toast.success('Category created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create category: ' + error.message);
    }
  });

  const updateCategoryMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.ForumCategory.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forum-categories'] });
      setShowCategoryDialog(false);
      resetCategoryForm();
      toast.success('Category updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update category: ' + error.message);
    }
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id) => base44.entities.ForumCategory.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forum-categories'] });
      queryClient.invalidateQueries({ queryKey: ['forum-threads'] });
      setShowDeleteConfirm(false);
      setCategoryToDelete(null);
      toast.success('Category deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete category: ' + error.message);
    }
  });

  const updateReportMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.ForumReport.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['forum-reports'] });
      setShowReportDialog(false);
      setSelectedReport(null);
      setResolutionNote('');
      toast.success('Report updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update report: ' + error.message);
    }
  });

  const resetCategoryForm = () => {
    setCategoryForm({ name: '', description: '', slug: '', display_order: 0, is_active: true, group_id: '', icon: '', header_image_url: '', header_image_focal_point: { x: 50, y: 50 } });
    setEditingCategory(null);
    setSlugManuallyEdited(false);
  };

  const handleCreateCategory = () => {
    resetCategoryForm();
    setCategoryForm(prev => ({ ...prev, display_order: categories.length }));
    setShowCategoryDialog(true);
  };

  const handleEditCategory = (category) => {
    setEditingCategory(category);
    setCategoryForm({
      name: category.name || '',
      description: category.description || '',
      slug: category.slug || '',
      display_order: category.display_order ?? 0,
      is_active: category.is_active !== false,
      group_id: category.group_id || '',
      icon: category.icon || '',
      header_image_url: category.header_image_url || '',
      header_image_focal_point: category.header_image_focal_point || { x: 50, y: 50 }
    });
    setSlugManuallyEdited(true);
    setShowCategoryDialog(true);
  };

  const handleDeleteCategory = (category) => {
    setCategoryToDelete(category);
    setShowDeleteConfirm(true);
  };

  const handleSaveCategory = () => {
    if (!categoryForm.name.trim()) {
      toast.error('Category name is required');
      return;
    }
    if (!categoryForm.slug.trim()) {
      toast.error('Slug is required');
      return;
    }

    const data = {
      name: categoryForm.name.trim(),
      description: categoryForm.description.trim(),
      slug: categoryForm.slug.trim(),
      display_order: parseInt(categoryForm.display_order) || 0,
      is_active: categoryForm.is_active,
      icon: categoryForm.icon.trim() || null,
      group_id: categoryForm.group_id || null,
      header_image_url: categoryForm.header_image_url || null,
      header_image_focal_point: categoryForm.header_image_url ? categoryForm.header_image_focal_point : null
    };

    if (editingCategory) {
      updateCategoryMutation.mutate({ id: editingCategory.id, data });
    } else {
      createCategoryMutation.mutate(data);
    }
  };

  const handleNameChange = (value) => {
    setCategoryForm(prev => ({
      ...prev,
      name: value,
      slug: slugManuallyEdited ? prev.slug : generateSlug(value)
    }));
  };

  const handleSlugChange = (value) => {
    setSlugManuallyEdited(true);
    setCategoryForm(prev => ({ ...prev, slug: generateSlug(value) }));
  };

  const handleReportAction = (report, action) => {
    setSelectedReport(report);
    setResolutionNote('');
    if (action === 'review') {
      updateReportMutation.mutate({ id: report.id, data: { status: 'reviewed' } });
    } else {
      setShowReportDialog(true);
    }
  };

  const handleSubmitReportAction = (status) => {
    if (!selectedReport) return;
    const data = {
      status,
      resolution_note: resolutionNote.trim() || null,
      resolved_at: new Date().toISOString()
    };
    updateReportMutation.mutate({ id: selectedReport.id, data });
  };

  const handleInitializeTables = async () => {
    setInitializingTables(true);
    setInitResult(null);
    try {
      const response = await fetch('/api/admin/init-forum-tables', {
        method: 'POST',
        credentials: 'include'
      });
      const result = await response.json();
      if (result.success) {
        toast.success(result.message || 'Forum tables created successfully');
        setInitResult(null);
        queryClient.invalidateQueries({ queryKey: ['forum-categories'] });
        queryClient.invalidateQueries({ queryKey: ['forum-threads'] });
        queryClient.invalidateQueries({ queryKey: ['forum-reports'] });
      } else {
        setInitResult(result);
        if (result.sql) {
          toast.info('Tables need to be created manually. SQL provided below.');
        } else {
          toast.error(result.message || 'Failed to initialize tables');
        }
      }
    } catch (error) {
      toast.error('Failed to initialize forum tables: ' + error.message);
    } finally {
      setInitializingTables(false);
    }
  };

  const getMemberName = (memberId) => {
    const member = membersMap[memberId];
    if (!member) return memberId?.substring(0, 8) || 'Unknown';
    return [member.first_name, member.last_name].filter(Boolean).join(' ') || member.email || 'Unknown';
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'pending':
        return <Badge variant="outline" className="text-amber-700 border-amber-300"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      case 'reviewed':
        return <Badge variant="outline" className="text-blue-600 border-blue-300"><Eye className="w-3 h-3 mr-1" />Reviewed</Badge>;
      case 'resolved':
        return <Badge variant="outline" className="text-green-600 border-green-300"><CheckCircle className="w-3 h-3 mr-1" />Resolved</Badge>;
      case 'dismissed':
        return <Badge variant="secondary"><XCircle className="w-3 h-3 mr-1" />Dismissed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[400px]" data-testid="loading-access">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6" data-testid="forum-management-page">
      <div className="flex flex-row flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Forum Management</h1>
          <p className="text-muted-foreground text-sm">Manage forum categories and moderation</p>
        </div>
      </div>

      {tablesNotReady && (
        <Card data-testid="card-init-tables">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              Initialize Forum Tables
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Forum tables have not been created yet. Click the button below to initialize the database tables required for the forum.
            </p>
            {initResult?.sql && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-amber-700">
                  Automatic creation is not available. Please run the following SQL in your Supabase SQL editor:
                </p>
                <pre className="bg-muted p-4 rounded-md text-xs overflow-auto max-h-64" data-testid="text-init-sql">
                  {initResult.sql}
                </pre>
              </div>
            )}
            <Button
              onClick={handleInitializeTables}
              disabled={initializingTables}
              data-testid="button-init-tables"
            >
              {initializingTables ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Initializing...</>
              ) : (
                <><Database className="w-4 h-4 mr-2" />Initialize Forum Tables</>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {!tablesNotReady && (
        <Tabs value={activeTab} onValueChange={setActiveTab} data-testid="tabs-forum">
          <TabsList>
            <TabsTrigger value="categories" data-testid="tab-categories">
              <MessageSquare className="w-4 h-4 mr-1" />Categories
            </TabsTrigger>
            <TabsTrigger value="moderation" data-testid="tab-moderation">
              <Shield className="w-4 h-4 mr-1" />Moderation
            </TabsTrigger>
          </TabsList>

          <TabsContent value="categories" className="space-y-4">
            <div className="flex flex-row flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Forum Categories</h2>
              <Button onClick={handleCreateCategory} data-testid="button-create-category">
                <Plus className="w-4 h-4 mr-2" />Add Category
              </Button>
            </div>

            {categoriesLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : categories.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <MessageSquare className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">No forum categories yet. Create your first category to get started.</p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">Order</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Slug</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Group</TableHead>
                      <TableHead className="text-center">Threads</TableHead>
                      <TableHead className="text-center">Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {categories.map((category) => (
                      <TableRow key={category.id} data-testid={`row-category-${category.id}`}>
                        <TableCell>
                          <span className="text-sm text-muted-foreground flex items-center gap-1">
                            <ArrowUpDown className="w-3 h-3" />
                            {category.display_order}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {category.header_image_url ? (
                              <div className="w-8 h-8 rounded overflow-hidden shrink-0 border">
                                <img
                                  src={category.header_image_url}
                                  alt=""
                                  className="w-full h-full object-cover"
                                  style={category.header_image_focal_point ? { objectPosition: `${category.header_image_focal_point.x}% ${category.header_image_focal_point.y}%` } : undefined}
                                />
                              </div>
                            ) : category.icon ? (
                              <span className="text-sm">{category.icon}</span>
                            ) : null}
                            <span className="font-medium" data-testid={`text-category-name-${category.id}`}>{category.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{category.slug}</code>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground line-clamp-1">{category.description || '-'}</span>
                        </TableCell>
                        <TableCell>
                          {category.group_id && groupsMap[category.group_id] ? (
                            <Badge variant="secondary" size="sm">{groupsMap[category.group_id].name}</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">None</span>
                          )}
                        </TableCell>
                        <TableCell className="text-center">
                          <Badge variant="outline">{threadCountByCategory[category.id] || 0}</Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          {category.is_active !== false ? (
                            <Badge variant="outline" className="text-green-600 border-green-300">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleEditCategory(category)}
                              data-testid={`button-edit-category-${category.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleDeleteCategory(category)}
                              data-testid={`button-delete-category-${category.id}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="moderation" className="space-y-4">
            <div className="flex flex-row flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Moderation Reports</h2>
              <div className="flex items-center gap-2">
                <Button
                  variant={showModLog ? "default" : "outline"}
                  onClick={() => setShowModLog(!showModLog)}
                  data-testid="button-toggle-mod-log"
                >
                  <FileText className="w-4 h-4 mr-2" />Moderation Log
                </Button>
                <Select value={reportStatusFilter} onValueChange={setReportStatusFilter}>
                  <SelectTrigger className="w-[140px]" data-testid="select-report-status">
                    <SelectValue placeholder="Filter status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="reviewed">Reviewed</SelectItem>
                    <SelectItem value="resolved">Resolved</SelectItem>
                    <SelectItem value="dismissed">Dismissed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {showModLog && (
              <Card data-testid="card-moderation-log">
                <CardHeader>
                  <CardTitle className="text-base">Moderation Log</CardTitle>
                </CardHeader>
                <CardContent>
                  {modLogsLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : moderationLogs.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No moderation actions recorded yet.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Action</TableHead>
                          <TableHead>Target</TableHead>
                          <TableHead>Performed By</TableHead>
                          <TableHead>Date</TableHead>
                          <TableHead>Details</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {moderationLogs.slice(0, 50).map((log) => (
                          <TableRow key={log.id} data-testid={`row-mod-log-${log.id}`}>
                            <TableCell>
                              <Badge variant="outline">{log.action}</Badge>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm">{log.target_type} / {log.target_id?.substring(0, 8)}</span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm">{getMemberName(log.performed_by)}</span>
                            </TableCell>
                            <TableCell>
                              <span className="text-sm text-muted-foreground">
                                {log.created_at ? new Date(log.created_at).toLocaleDateString() : '-'}
                              </span>
                            </TableCell>
                            <TableCell>
                              <span className="text-xs text-muted-foreground">
                                {log.details ? JSON.stringify(log.details).substring(0, 60) : '-'}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            )}

            {reportsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredReports.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <Shield className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-muted-foreground">
                    {reportStatusFilter === 'all' ? 'No moderation reports.' : `No ${reportStatusFilter} reports.`}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Reporter</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Details</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Resolution</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredReports.map((report) => (
                      <TableRow key={report.id} data-testid={`row-report-${report.id}`}>
                        <TableCell>{getStatusBadge(report.status)}</TableCell>
                        <TableCell>
                          <span className="text-sm font-medium">{getMemberName(report.reported_by)}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{report.reason}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground line-clamp-2">{report.details || '-'}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {report.created_at ? new Date(report.created_at).toLocaleDateString() : '-'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">{report.resolution_note || '-'}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          {(report.status === 'pending' || report.status === 'reviewed') && (
                            <div className="flex items-center justify-end gap-1">
                              {report.status === 'pending' && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleReportAction(report, 'review')}
                                  data-testid={`button-review-report-${report.id}`}
                                >
                                  <Eye className="w-3 h-3 mr-1" />Review
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleReportAction(report, 'resolve')}
                                data-testid={`button-resolve-report-${report.id}`}
                              >
                                <CheckCircle className="w-3 h-3 mr-1" />Resolve
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleReportAction(report, 'dismiss')}
                                data-testid={`button-dismiss-report-${report.id}`}
                              >
                                <XCircle className="w-3 h-3 mr-1" />Dismiss
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      )}

      <Dialog open={showCategoryDialog} onOpenChange={(open) => { if (!open) { setShowCategoryDialog(false); resetCategoryForm(); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-category">
          <DialogHeader>
            <DialogTitle>{editingCategory ? 'Edit Category' : 'Create Category'}</DialogTitle>
            <DialogDescription>
              {editingCategory ? 'Update the forum category details.' : 'Add a new forum category for discussions.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cat-name">Name</Label>
              <Input
                id="cat-name"
                value={categoryForm.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. General Discussion"
                data-testid="input-category-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cat-slug">Slug</Label>
              <Input
                id="cat-slug"
                value={categoryForm.slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="auto-generated-from-name"
                data-testid="input-category-slug"
              />
              <p className="text-xs text-muted-foreground">Auto-generated from name. You can manually override.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cat-desc">Description</Label>
              <Textarea
                id="cat-desc"
                value={categoryForm.description}
                onChange={(e) => setCategoryForm(prev => ({ ...prev, description: e.target.value }))}
                placeholder="Brief description of this category"
                rows={3}
                data-testid="input-category-description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="cat-order">Display Order</Label>
                <Input
                  id="cat-order"
                  type="number"
                  value={categoryForm.display_order}
                  onChange={(e) => setCategoryForm(prev => ({ ...prev, display_order: parseInt(e.target.value) || 0 }))}
                  data-testid="input-category-order"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cat-icon">Icon</Label>
                <Input
                  id="cat-icon"
                  value={categoryForm.icon}
                  onChange={(e) => setCategoryForm(prev => ({ ...prev, icon: e.target.value }))}
                  placeholder="e.g. icon name"
                  data-testid="input-category-icon"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cat-group">Member Group (optional)</Label>
              <Select
                value={categoryForm.group_id || '__none__'}
                onValueChange={(val) => setCategoryForm(prev => ({ ...prev, group_id: val === '__none__' ? '' : val }))}
              >
                <SelectTrigger data-testid="select-category-group">
                  <SelectValue placeholder="No group restriction" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No group restriction</SelectItem>
                  {memberGroups.map(group => (
                    <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <EventImageUpload
                value={categoryForm.header_image_url}
                onChange={(url) => setCategoryForm(prev => ({ ...prev, header_image_url: url }))}
                label="Header Image"
                helpText="Optional: Add a banner image for this forum category"
                data-testid="input-category-header-image"
              />
              {categoryForm.header_image_url && (
                <FocalPointPicker
                  imageUrl={categoryForm.header_image_url}
                  focalPoint={categoryForm.header_image_focal_point}
                  onChange={(fp) => setCategoryForm(prev => ({ ...prev, header_image_focal_point: fp }))}
                />
              )}
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="cat-active">Active</Label>
              <Switch
                id="cat-active"
                checked={categoryForm.is_active}
                onCheckedChange={(checked) => setCategoryForm(prev => ({ ...prev, is_active: checked }))}
                data-testid="switch-category-active"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCategoryDialog(false); resetCategoryForm(); }} data-testid="button-cancel-category">
              Cancel
            </Button>
            <Button
              onClick={handleSaveCategory}
              disabled={createCategoryMutation.isPending || updateCategoryMutation.isPending}
              data-testid="button-save-category"
            >
              {(createCategoryMutation.isPending || updateCategoryMutation.isPending) ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              {editingCategory ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent data-testid="dialog-delete-category">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Category
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{categoryToDelete?.name}&quot;? This will also delete all threads and posts within this category. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => categoryToDelete && deleteCategoryMutation.mutate(categoryToDelete.id)}
              disabled={deleteCategoryMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteCategoryMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showReportDialog} onOpenChange={(open) => { if (!open) { setShowReportDialog(false); setSelectedReport(null); setResolutionNote(''); } }}>
        <DialogContent data-testid="dialog-report-action">
          <DialogHeader>
            <DialogTitle>Resolve / Dismiss Report</DialogTitle>
            <DialogDescription>
              Add a resolution note and choose an action for this report.
            </DialogDescription>
          </DialogHeader>
          {selectedReport && (
            <div className="space-y-4">
              <div className="space-y-1">
                <p className="text-sm font-medium">Reporter: {getMemberName(selectedReport.reported_by)}</p>
                <p className="text-sm"><span className="text-muted-foreground">Reason:</span> {selectedReport.reason}</p>
                {selectedReport.details && (
                  <p className="text-sm"><span className="text-muted-foreground">Details:</span> {selectedReport.details}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="resolution-note">Resolution Note</Label>
                <Textarea
                  id="resolution-note"
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  placeholder="Add a note about the resolution..."
                  rows={3}
                  data-testid="input-resolution-note"
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setShowReportDialog(false); setSelectedReport(null); }} data-testid="button-cancel-report">
              Cancel
            </Button>
            <Button
              variant="ghost"
              onClick={() => handleSubmitReportAction('dismissed')}
              disabled={updateReportMutation.isPending}
              data-testid="button-dismiss-report"
            >
              <XCircle className="w-4 h-4 mr-1" />Dismiss
            </Button>
            <Button
              onClick={() => handleSubmitReportAction('resolved')}
              disabled={updateReportMutation.isPending}
              data-testid="button-resolve-report"
            >
              {updateReportMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-1" />}
              Resolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
