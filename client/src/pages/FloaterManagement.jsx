
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Pencil, Trash2, Upload, MousePointer2, Eye, EyeOff, Link as LinkIcon, Webhook } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function FloaterManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady, authResolved, sessionValidated } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingFloater, setEditingFloater] = useState(null);
  const [deletingFloater, setDeletingFloater] = useState(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    image_url: "",
    action_type: "webhook",
    webhook_url: "",
    redirect_url: "",
    form_slug: "", // Added form_slug
    window_target: "new_tab",
    popup_width: 800,
    popup_height: 600,
    display_location: "both",
    position: "bottom-right",
    offset_x: 20,
    offset_y: 20,
    width: 80,
    height: 80,
    show_background: true,
    is_active: true,
    display_order: 0
  });

  const queryClient = useQueryClient();

  // SECURITY: Only consider authenticated when auth check complete AND session validated
  const isAuthenticated = authResolved && sessionValidated;

  // SECURITY: Gate query on auth to prevent fetching before tenant context is ready
  const { data: floaters = [], isLoading } = useQuery({
    queryKey: ['floaters'],
    queryFn: async () => {
      const allFloaters = await base44.entities.Floater.list();
      return allFloaters.sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
    },
    staleTime: 0, // Admin views need instant freshness after edits
    enabled: isAuthenticated,
  });

  // SECURITY: Gate on auth to prevent cross-tenant data leakage
  const { data: forms = [] } = useQuery({
    queryKey: ['forms'],
    queryFn: async () => {
      return await base44.entities.Form.list();
    },
    enabled: isAuthenticated,
  });

  const createFloaterMutation = useMutation({
    mutationFn: async (floaterData) => {
      return await base44.entities.Floater.create(floaterData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['floaters'] });
      toast.success('Floater created successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to create floater');
    }
  });

  const updateFloaterMutation = useMutation({
    mutationFn: async ({ id, floaterData }) => {
      return await base44.entities.Floater.update(id, floaterData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['floaters'] });
      toast.success('Floater updated successfully');
      handleCloseDialog();
    },
    onError: (error) => {
      toast.error('Failed to update floater');
    }
  });

  const deleteFloaterMutation = useMutation({
    mutationFn: async (id) => {
      return await base44.entities.Floater.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['floaters'] });
      toast.success('Floater deleted successfully');
      setDeleteDialogOpen(false);
      setDeletingFloater(null);
    },
    onError: (error) => {
      toast.error('Failed to delete floater');
    }
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_FloaterManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const handleOpenDialog = (floater = null) => {
    if (floater) {
      setEditingFloater(floater);
      setFormData({
        name: floater.name || "",
        description: floater.description || "",
        image_url: floater.image_url || "",
        action_type: floater.action_type || "webhook",
        webhook_url: floater.webhook_url || "",
        redirect_url: floater.redirect_url || "",
        form_slug: floater.form_slug || "", // Set form_slug from existing floater
        window_target: floater.window_target || "new_tab",
        popup_width: floater.popup_width || 800,
        popup_height: floater.popup_height || 600,
        display_location: floater.display_location || "both",
        position: floater.position || "bottom-right",
        offset_x: floater.offset_x ?? 20,
        offset_y: floater.offset_y ?? 20,
        width: floater.width || 80,
        height: floater.height || 80,
        show_background: floater.show_background ?? true,
        is_active: floater.is_active ?? true,
        display_order: floater.display_order || 0
      });
    } else {
      setEditingFloater(null);
      setFormData({
        name: "",
        description: "",
        image_url: "",
        action_type: "webhook",
        webhook_url: "",
        redirect_url: "",
        form_slug: "", // Reset form_slug
        window_target: "new_tab",
        popup_width: 800,
        popup_height: 600,
        display_location: "both",
        position: "bottom-right",
        offset_x: 20,
        offset_y: 20,
        width: 80,
        height: 80,
        show_background: true,
        is_active: true,
        display_order: 0
      });
    }
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingFloater(null);
    setFormData({
      name: "",
      description: "",
      image_url: "",
      action_type: "webhook",
      webhook_url: "",
      redirect_url: "",
      form_slug: "", // Reset form_slug
      window_target: "new_tab",
      popup_width: 800,
      popup_height: 600,
      display_location: "both",
      position: "bottom-right",
      offset_x: 20,
      offset_y: 20,
      width: 80,
      height: 80,
      show_background: true,
      is_active: true,
      display_order: 0
    });
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    setIsUploadingImage(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      setFormData(prev => ({ ...prev, image_url: result.file_url }));
      toast.success('Image uploaded successfully');
    } catch (error) {
      toast.error('Failed to upload image');
    } finally {
      setIsUploadingImage(false);
    }
  };

  const handleSubmit = () => {
    if (!formData.name || !formData.image_url) {
      toast.error('Please fill in name and image');
      return;
    }

    if (formData.action_type === 'webhook' && !formData.webhook_url) {
      toast.error('Please provide a webhook URL');
      return;
    }

    if (formData.action_type === 'url' && !formData.redirect_url) {
      toast.error('Please provide a redirect URL');
      return;
    }

    if (formData.action_type === 'form' && !formData.form_slug) {
      toast.error('Please select a form');
      return;
    }

    const floaterData = {
      name: formData.name,
      description: formData.description,
      image_url: formData.image_url,
      action_type: formData.action_type,
      webhook_url: formData.webhook_url,
      redirect_url: formData.redirect_url,
      form_slug: formData.form_slug, // Included form_slug
      window_target: formData.window_target,
      popup_width: Number(formData.popup_width),
      popup_height: Number(formData.popup_height),
      display_location: formData.display_location,
      position: formData.position,
      offset_x: Number(formData.offset_x),
      offset_y: Number(formData.offset_y),
      width: Number(formData.width),
      height: Number(formData.height),
      show_background: formData.show_background,
      is_active: formData.is_active,
      display_order: Number(formData.display_order)
    };

    if (editingFloater) {
      updateFloaterMutation.mutate({ id: editingFloater.id, floaterData });
    } else {
      createFloaterMutation.mutate(floaterData);
    }
  };

  const handleDelete = () => {
    if (!deletingFloater) return;
    deleteFloaterMutation.mutate(deletingFloater.id);
  };

  const getLocationBadgeInfo = (location) => {
    switch (location) {
      case 'portal':
        return { text: 'Portal Only', className: 'bg-blue-100 text-blue-700' };
      case 'public':
        return { text: 'Public Only', className: 'bg-green-100 text-green-700' };
      case 'both':
        return { text: 'Portal & Public', className: 'bg-purple-100 text-purple-700' };
      default:
        return { text: location, className: 'bg-slate-100 text-slate-700' };
    }
  };

  if (!accessChecked || isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Floater Management
            </h1>
            <p className="text-slate-600">Create and manage floating widget elements</p>
          </div>
          <Button
            onClick={() => handleOpenDialog()}
            className="bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="w-4 h-4 mr-2" />
            Create Floater
          </Button>
        </div>

        {floaters.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <MousePointer2 className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No floaters yet</h3>
              <p className="text-slate-600 mb-6">Create your first floating widget to get started</p>
              <Button onClick={() => handleOpenDialog()} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create Floater
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {floaters.map(floater => {
              const locationBadge = getLocationBadgeInfo(floater.display_location);
              return (
                <Card key={floater.id} className="border-slate-200 hover:shadow-lg transition-shadow">
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <CardTitle className="text-base mb-2">{floater.name}</CardTitle>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge className={locationBadge.className}>
                            {locationBadge.text} {/* Changed to .text */}
                          </Badge>
                          <Badge variant="outline" className="gap-1">
                            {floater.action_type === 'webhook' ? (
                              <>
                                <Webhook className="w-3 h-3" />
                                Webhook
                              </>
                            ) : floater.action_type === 'url' ? (
                              <>
                                <LinkIcon className="w-3 h-3" />
                                {floater.window_target === 'popup' ? 'Popup' :
                                 floater.window_target === 'parent' ? 'Parent' :
                                 floater.window_target === 'current' ? 'Current' : 'New Tab'}
                              </>
                            ) : (
                              <>
                                <LinkIcon className="w-3 h-3" /> {/* Or a new icon for forms */}
                                Form
                              </>
                            )}
                          </Badge>
                          <Badge variant={floater.is_active ? "default" : "secondary"}>
                            {floater.is_active ? (
                              <>
                                <Eye className="w-3 h-3 mr-1" />
                                Active
                              </>
                            ) : (
                              <>
                                <EyeOff className="w-3 h-3 mr-1" />
                                Inactive
                              </>
                            )}
                          </Badge>
                        </div>
                      </div>
                      {floater.image_url && (
                        <img
                          src={floater.image_url}
                          alt={floater.name}
                          className="w-16 h-16 object-contain border border-slate-200 rounded ml-2"
                        />
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {floater.description && (
                      <p className="text-xs text-slate-600 line-clamp-2">{floater.description}</p>
                    )}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">Action:</span>
                      <span className="text-xs text-slate-900 truncate max-w-[180px]" title={
                        floater.action_type === 'webhook' ? floater.webhook_url :
                        floater.action_type === 'url' ? floater.redirect_url :
                        floater.action_type === 'form' ? floater.form_slug : ''
                      }>
                        {floater.action_type === 'webhook' ? floater.webhook_url :
                         floater.action_type === 'url' ? floater.redirect_url :
                         floater.action_type === 'form' ? `Form: ${floater.form_slug}` : 'N/A'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">Position:</span>
                      <Badge variant="secondary">{floater.position}</Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">Size:</span>
                      <Badge variant="secondary">{floater.width}x{floater.height}px</Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">Background:</span>
                      <Badge variant="secondary">{floater.show_background ?? true ? 'Yes' : 'No'}</Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-600">Clicks:</span>
                      <Badge variant="secondary">{floater.click_count || 0}</Badge>
                    </div>
                    <div className="flex gap-2 pt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleOpenDialog(floater)}
                      >
                        <Pencil className="w-3 h-3 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDeletingFloater(floater);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingFloater ? 'Edit' : 'Create'} Floater</DialogTitle>
            <DialogDescription>
              Configure a floating widget that can trigger a webhook, navigate to a URL, or open a form.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g., Help Widget, Contact Button"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="What does this floater do?"
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="image">Image *</Label>
              <div className="flex items-center gap-4">
                {formData.image_url && (
                  <img src={formData.image_url} alt="Floater" className="w-20 h-20 object-contain border border-slate-200 rounded" />
                )}
                <div className="flex-1">
                  <input
                    type="file"
                    id="image-upload"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isUploadingImage}
                    onClick={() => document.getElementById('image-upload').click()}
                  >
                    {isUploadingImage ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 mr-2" />
                        Upload Image
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="action-type">Click Action *</Label>
              <Select
                value={formData.action_type}
                onValueChange={(value) => setFormData({ ...formData, action_type: value })}
              >
                <SelectTrigger id="action-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="webhook">Call Webhook</SelectItem>
                  <SelectItem value="url">Navigate to URL</SelectItem>
                  <SelectItem value="form">Open Form</SelectItem> {/* Added Open Form */}
                </SelectContent>
              </Select>
            </div>

            {formData.action_type === 'webhook' && (
              <div className="space-y-2">
                <Label htmlFor="webhook-url">Webhook URL *</Label>
                <Input
                  id="webhook-url"
                  type="url"
                  value={formData.webhook_url}
                  onChange={(e) => setFormData({ ...formData, webhook_url: e.target.value })}
                  placeholder="https://example.com/webhook"
                />
                <p className="text-xs text-slate-500">URL to call when the floater is clicked</p>
              </div>
            )}

            {formData.action_type === 'url' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="redirect-url">Redirect URL *</Label>
                  <Input
                    id="redirect-url"
                    type="url"
                    value={formData.redirect_url}
                    onChange={(e) => setFormData({ ...formData, redirect_url: e.target.value })}
                    placeholder="https://example.com/page"
                  />
                  <p className="text-xs text-slate-500">URL to navigate to when clicked</p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="window-target">Window Target *</Label>
                  <Select
                    value={formData.window_target}
                    onValueChange={(value) => setFormData({ ...formData, window_target: value })}
                  >
                    <SelectTrigger id="window-target">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="current">Current Window</SelectItem>
                      <SelectItem value="new_tab">New Tab</SelectItem>
                      <SelectItem value="parent">Parent Window</SelectItem>
                      <SelectItem value="popup">Popup Window</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.window_target === 'popup' && (
                  <div className="grid grid-cols-2 gap-4 pl-4 border-l-2 border-blue-200 bg-blue-50 p-3 rounded">
                    <div className="space-y-2">
                      <Label htmlFor="popup-width">Popup Width (px)</Label>
                      <Input
                        id="popup-width"
                        type="number"
                        value={formData.popup_width}
                        onChange={(e) => setFormData({ ...formData, popup_width: parseInt(e.target.value, 10) })}
                        min={200}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="popup-height">Popup Height (px)</Label>
                      <Input
                        id="popup-height"
                        type="number"
                        value={formData.popup_height}
                        onChange={(e) => setFormData({ ...formData, popup_height: parseInt(e.target.value, 10) })}
                        min={200}
                      />
                    </div>
                  </div>
                )}
              </>
            )}

            {formData.action_type === 'form' && (
              <div className="space-y-2">
                <Label htmlFor="form-slug">Form *</Label>
                <Select
                  value={formData.form_slug}
                  onValueChange={(value) => setFormData({ ...formData, form_slug: value })}
                >
                  <SelectTrigger id="form-slug">
                    <SelectValue placeholder="Select a form" />
                  </SelectTrigger>
                  <SelectContent>
                    {forms.map(form => (
                      <SelectItem key={form.id} value={form.slug}>
                        {form.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {forms.length === 0 && (
                  <p className="text-xs text-amber-600">No forms available. Create a form first.</p>
                )}
                <p className="text-xs text-slate-500">The form to open when the floater is clicked</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="display_location">Display Location *</Label>
                <Select
                  value={formData.display_location}
                  onValueChange={(value) => setFormData({ ...formData, display_location: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="portal">Portal Only</SelectItem>
                    <SelectItem value="public">Public Only</SelectItem>
                    <SelectItem value="both">Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="position">Position *</Label>
                <Select
                  value={formData.position}
                  onValueChange={(value) => setFormData({ ...formData, position: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bottom-right">Bottom Right</SelectItem>
                    <SelectItem value="bottom-left">Bottom Left</SelectItem>
                    <SelectItem value="top-right">Top Right</SelectItem>
                    <SelectItem value="top-left">Top Left</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="offset_x">Offset X (px)</Label>
                <Input
                  id="offset_x"
                  type="number"
                  value={formData.offset_x}
                  onChange={(e) => setFormData({ ...formData, offset_x: parseInt(e.target.value, 10) })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="offset_y">Offset Y (px)</Label>
                <Input
                  id="offset_y"
                  type="number"
                  value={formData.offset_y}
                  onChange={(e) => setFormData({ ...formData, offset_y: parseInt(e.target.value, 10) })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="width">Width (px)</Label>
                <Input
                  id="width"
                  type="number"
                  value={formData.width}
                  onChange={(e) => setFormData({ ...formData, width: parseInt(e.target.value, 10) })}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="height">Height (px)</Label>
                <Input
                  id="height"
                  type="number"
                  value={formData.height}
                  onChange={(e) => setFormData({ ...formData, height: parseInt(e.target.value, 10) })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="display_order">Display Order</Label>
              <Input
                id="display_order"
                type="number"
                value={formData.display_order}
                onChange={(e) => setFormData({ ...formData, display_order: parseInt(e.target.value, 10) })}
              />
              <p className="text-xs text-slate-500">Lower numbers appear first</p>
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="show_background">Show Background</Label>
              <Switch
                id="show_background"
                checked={formData.show_background}
                onCheckedChange={(checked) => setFormData({ ...formData, show_background: checked })}
              />
            </div>
            <p className="text-xs text-slate-500 -mt-2">Display rounded background and shadow</p>

            <div className="flex items-center justify-between">
              <Label htmlFor="is_active">Active</Label>
              <Switch
                id="is_active"
                checked={formData.is_active}
                onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {editingFloater ? 'Update' : 'Create'} Floater
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the floater "{deletingFloater?.name}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
