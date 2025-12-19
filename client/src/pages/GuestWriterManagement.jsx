import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Plus, Edit, Trash2, User, Mail, Briefcase, Building, Upload, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
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
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function GuestWriterManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('content.guest-writers')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingWriter, setEditingWriter] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [writerToDelete, setWriterToDelete] = useState(null);
  const [isUploading, setIsUploading] = useState(false);

  const [formData, setFormData] = useState({
    full_name: "",
    email: "",
    organization: "",
    job_title: "",
    biography: "",
    profile_photo_url: "",
    is_active: true
  });

  const queryClient = useQueryClient();

  const { data: guestWriters = [], isLoading } = useQuery({
    queryKey: ['guest-writers'],
    queryFn: async () => {
      const writers = await base44.entities.GuestWriter.list();
      return writers;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (editingWriter) {
        return await base44.entities.GuestWriter.update(editingWriter.id, data);
      } else {
        return await base44.entities.GuestWriter.create(data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['guest-writers'] });
      toast.success(editingWriter ? 'Guest writer updated' : 'Guest writer created');
      handleCloseEditor();
    },
    onError: (error) => {
      toast.error('Failed to save guest writer: ' + error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      await base44.entities.GuestWriter.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['guest-writers'] });
      toast.success('Guest writer deleted');
      setDeleteDialogOpen(false);
      setWriterToDelete(null);
    },
    onError: (error) => {
      toast.error('Failed to delete guest writer: ' + error.message);
    },
  });

  const handleOpenEditor = (writer = null) => {
    if (writer) {
      setEditingWriter(writer);
      setFormData({
        full_name: writer.full_name || "",
        email: writer.email || "",
        organization: writer.organization || "",
        job_title: writer.job_title || "",
        biography: writer.biography || "",
        profile_photo_url: writer.profile_photo_url || "",
        is_active: writer.is_active !== false
      });
    } else {
      setEditingWriter(null);
      setFormData({
        full_name: "",
        email: "",
        organization: "",
        job_title: "",
        biography: "",
        profile_photo_url: "",
        is_active: true
      });
    }
    setIsEditorOpen(true);
  };

  const handleCloseEditor = () => {
    setIsEditorOpen(false);
    setEditingWriter(null);
    setFormData({
      full_name: "",
      email: "",
      organization: "",
      job_title: "",
      biography: "",
      profile_photo_url: "",
      is_active: true
    });
  };

  const handleSave = () => {
    if (!formData.full_name.trim() || !formData.email.trim()) {
      toast.error('Name and email are required');
      return;
    }

    saveMutation.mutate(formData);
  };

  const handleDeleteClick = (writer) => {
    setWriterToDelete(writer);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (writerToDelete) {
      deleteMutation.mutate(writerToDelete.id);
    }
  };

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please upload an image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }

    setIsUploading(true);
    const uploadResult = await base44.integrations.Core.UploadFile({ file });
    setFormData({ ...formData, profile_photo_url: uploadResult.file_url });
    setIsUploading(false);
    toast.success('Photo uploaded');
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 mb-2">Guest Writers</h1>
            <p className="text-slate-600">
              Manage guest writer profiles for article attribution
            </p>
          </div>
          <Button
            onClick={() => handleOpenEditor()}
            className="bg-blue-600 hover:bg-blue-700 gap-2"
          >
            <Plus className="w-4 h-4" />
            Add Guest Writer
          </Button>
        </div>

        {isLoading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array(6).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse border-slate-200">
                <CardContent className="p-6">
                  <div className="h-20 bg-slate-200 rounded mb-4" />
                  <div className="h-4 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-3 bg-slate-200 rounded w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : guestWriters.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <User className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No guest writers yet
              </h3>
              <p className="text-slate-600 mb-4">
                Create guest writer profiles to attribute articles to external contributors
              </p>
              <Button
                onClick={() => handleOpenEditor()}
                className="bg-blue-600 hover:bg-blue-700 gap-2"
              >
                <Plus className="w-4 h-4" />
                Add First Guest Writer
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {guestWriters.map((writer) => (
              <Card key={writer.id} className="border-slate-200 shadow-sm hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex items-start gap-4 mb-4">
                    {writer.profile_photo_url ? (
                      <img
                        src={writer.profile_photo_url}
                        alt={writer.full_name}
                        className="w-16 h-16 rounded-full object-cover border-2 border-slate-200"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                        <User className="w-8 h-8 text-white" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-slate-900 mb-1">
                        {writer.full_name}
                      </h3>
                      {!writer.is_active && (
                        <span className="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                          Inactive
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 mb-4">
                    {writer.job_title && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Briefcase className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{writer.job_title}</span>
                      </div>
                    )}
                    {writer.organization && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Building className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{writer.organization}</span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 text-sm text-slate-600">
                      <Mail className="w-4 h-4 flex-shrink-0" />
                      <span className="truncate">{writer.email}</span>
                    </div>
                  </div>

                  {writer.biography && (
                    <p className="text-sm text-slate-600 line-clamp-3 mb-4">
                      {writer.biography}
                    </p>
                  )}

                  <div className="flex gap-2 pt-4 border-t border-slate-200">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenEditor(writer)}
                      className="flex-1 gap-2"
                    >
                      <Edit className="w-4 h-4" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeleteClick(writer)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Editor Dialog */}
        <Dialog open={isEditorOpen} onOpenChange={setIsEditorOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingWriter ? 'Edit Guest Writer' : 'Add Guest Writer'}
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Profile Photo */}
              <div className="space-y-2">
                <Label>Profile Photo</Label>
                <div className="flex items-center gap-4">
                  {formData.profile_photo_url ? (
                    <div className="relative">
                      <img
                        src={formData.profile_photo_url}
                        alt="Profile"
                        className="w-24 h-24 rounded-full object-cover border-2 border-slate-200"
                      />
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, profile_photo_url: "" })}
                        className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <div className="w-24 h-24 rounded-full bg-slate-200 flex items-center justify-center">
                      <User className="w-12 h-12 text-slate-400" />
                    </div>
                  )}
                  <div>
                    <input
                      type="file"
                      id="photo-upload"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                      className="hidden"
                      disabled={isUploading}
                    />
                    <Label htmlFor="photo-upload">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isUploading}
                        className="gap-2 cursor-pointer"
                        onClick={() => document.getElementById('photo-upload').click()}
                      >
                        {isUploading ? (
                          <>
                            <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                            Uploading...
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4" />
                            Upload Photo
                          </>
                        )}
                      </Button>
                    </Label>
                  </div>
                </div>
              </div>

              {/* Full Name */}
              <div className="space-y-2">
                <Label htmlFor="full_name">Full Name *</Label>
                <Input
                  id="full_name"
                  value={formData.full_name}
                  onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                  placeholder="John Smith"
                />
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john.smith@example.com"
                />
              </div>

              {/* Job Title */}
              <div className="space-y-2">
                <Label htmlFor="job_title">Job Title</Label>
                <Input
                  id="job_title"
                  value={formData.job_title}
                  onChange={(e) => setFormData({ ...formData, job_title: e.target.value })}
                  placeholder="Senior Consultant"
                />
              </div>

              {/* Organisation */}
              <div className="space-y-2">
                <Label htmlFor="organization">Organisation</Label>
                <Input
                  id="organization"
                  value={formData.organization}
                  onChange={(e) => setFormData({ ...formData, organization: e.target.value })}
                  placeholder="Example University"
                />
              </div>

              {/* Biography */}
              <div className="space-y-2">
                <Label htmlFor="biography">Biography</Label>
                <Textarea
                  id="biography"
                  value={formData.biography}
                  onChange={(e) => setFormData({ ...formData, biography: e.target.value })}
                  placeholder="Professional background and expertise..."
                  rows={4}
                />
              </div>

              {/* Is Active */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_active"
                  checked={formData.is_active}
                  onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                  className="w-4 h-4"
                />
                <Label htmlFor="is_active" className="cursor-pointer">
                  Active (available for article attribution)
                </Label>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleCloseEditor}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {saveMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Guest Writer</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete {writerToDelete?.full_name}? This action cannot be undone.
                Articles attributed to this guest writer will need to be reassigned.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteConfirm}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}