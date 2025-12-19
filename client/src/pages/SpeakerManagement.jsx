import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Plus, Edit, Trash2, User, Mail, Briefcase, Building, Upload, X, Mic, Settings, Save } from "lucide-react";
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

export default function SpeakerManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_SpeakerManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingSpeaker, setEditingSpeaker] = useState(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [speakerToDelete, setSpeakerToDelete] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [moduleNameSingular, setModuleNameSingular] = useState("Speaker");
  const [moduleNamePlural, setModuleNamePlural] = useState("Speakers");

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

  const { data: speakers = [], isLoading } = useQuery({
    queryKey: ['speakers'],
    queryFn: async () => {
      const speakerList = await base44.entities.Speaker.list();
      return speakerList;
    },
  });

  // Query for module name setting
  const { data: moduleNameSetting } = useQuery({
    queryKey: ['speaker-module-name'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'speaker_module_name');
    },
  });

  // Load module names from setting when data is available
  useEffect(() => {
    if (moduleNameSetting?.setting_value) {
      try {
        const names = JSON.parse(moduleNameSetting.setting_value);
        setModuleNameSingular(names.singular || "Speaker");
        setModuleNamePlural(names.plural || "Speakers");
      } catch {
        // If not valid JSON, treat as plain string for singular
        setModuleNameSingular(moduleNameSetting.setting_value);
        setModuleNamePlural(moduleNameSetting.setting_value + "s");
      }
    }
  }, [moduleNameSetting]);

  // Mutation to save module name setting
  const saveModuleNameMutation = useMutation({
    mutationFn: async ({ singular, plural }) => {
      const settingValue = JSON.stringify({ singular, plural });
      if (moduleNameSetting?.id) {
        return await base44.entities.SystemSettings.update(moduleNameSetting.id, {
          setting_value: settingValue
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'speaker_module_name',
          setting_value: settingValue
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['speaker-module-name'] });
      toast.success('Module name updated');
      setShowSettings(false);
    },
    onError: (error) => {
      console.error('Module name save error:', error);
      toast.error('Failed to save module name: ' + (error.message || 'Unknown error'));
    }
  });

  const handleSaveModuleName = () => {
    if (!moduleNameSingular.trim() || !moduleNamePlural.trim()) {
      toast.error('Please enter both singular and plural names');
      return;
    }
    saveModuleNameMutation.mutate({ 
      singular: moduleNameSingular.trim(), 
      plural: moduleNamePlural.trim() 
    });
  };

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (editingSpeaker) {
        return await base44.entities.Speaker.update(editingSpeaker.id, data);
      } else {
        return await base44.entities.Speaker.create(data);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['speakers'] });
      toast.success(editingSpeaker ? `${moduleNameSingular} updated` : `${moduleNameSingular} created`);
      handleCloseEditor();
    },
    onError: (error) => {
      toast.error(`Failed to save ${moduleNameSingular.toLowerCase()}: ` + error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      await base44.entities.Speaker.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['speakers'] });
      toast.success(`${moduleNameSingular} deleted`);
      setDeleteDialogOpen(false);
      setSpeakerToDelete(null);
    },
    onError: (error) => {
      toast.error(`Failed to delete ${moduleNameSingular.toLowerCase()}: ` + error.message);
    },
  });

  const handleOpenEditor = (speaker = null) => {
    if (speaker) {
      setEditingSpeaker(speaker);
      setFormData({
        full_name: speaker.full_name || "",
        email: speaker.email || "",
        organization: speaker.organization || "",
        job_title: speaker.job_title || "",
        biography: speaker.biography || "",
        profile_photo_url: speaker.profile_photo_url || "",
        is_active: speaker.is_active !== false
      });
    } else {
      setEditingSpeaker(null);
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
    setEditingSpeaker(null);
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
    if (!formData.full_name.trim()) {
      toast.error('Name is required');
      return;
    }

    saveMutation.mutate(formData);
  };

  const handleDeleteClick = (speaker) => {
    setSpeakerToDelete(speaker);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    if (speakerToDelete) {
      deleteMutation.mutate(speakerToDelete.id);
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
            <h1 className="text-3xl font-bold text-slate-900 mb-2">{moduleNamePlural}</h1>
            <p className="text-slate-600">
              Manage {moduleNameSingular.toLowerCase()} profiles for event assignments
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setShowSettings(!showSettings)}
              className="gap-2"
              data-testid="button-toggle-settings"
            >
              <Settings className="w-4 h-4" />
              Settings
            </Button>
            <Button
              onClick={() => handleOpenEditor()}
              className="bg-blue-600 hover:bg-blue-700 gap-2"
              data-testid="button-add-speaker"
            >
              <Plus className="w-4 h-4" />
              Add {moduleNameSingular}
            </Button>
          </div>
        </div>

        {/* Module Name Settings Panel */}
        {showSettings && (
          <Card className="border-slate-200 shadow-sm mb-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg flex items-center gap-2">
                <Settings className="h-5 w-5 text-blue-600" />
                Module Settings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600 mb-4">
                Customize how this module is named throughout the application. For example, you can rename "Speakers" to "Trainers" or "Presenters".
              </p>
              <div className="grid md:grid-cols-2 gap-4 mb-4">
                <div className="space-y-2">
                  <Label htmlFor="module-name-singular">Singular Name</Label>
                  <Input
                    id="module-name-singular"
                    value={moduleNameSingular}
                    onChange={(e) => setModuleNameSingular(e.target.value)}
                    placeholder="Speaker"
                    data-testid="input-module-name-singular"
                  />
                  <p className="text-xs text-slate-500">Used when referring to one person (e.g., "Add Speaker")</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="module-name-plural">Plural Name</Label>
                  <Input
                    id="module-name-plural"
                    value={moduleNamePlural}
                    onChange={(e) => setModuleNamePlural(e.target.value)}
                    placeholder="Speakers"
                    data-testid="input-module-name-plural"
                  />
                  <p className="text-xs text-slate-500">Used when referring to multiple people (e.g., "All Speakers")</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowSettings(false)}
                  data-testid="button-cancel-settings"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveModuleName}
                  disabled={saveModuleNameMutation.isPending}
                  className="bg-blue-600 hover:bg-blue-700 gap-2"
                  data-testid="button-save-module-name"
                >
                  {saveModuleNameMutation.isPending ? (
                    'Saving...'
                  ) : (
                    <>
                      <Save className="w-4 h-4" />
                      Save
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

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
        ) : speakers.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Mic className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No {moduleNamePlural.toLowerCase()} yet
              </h3>
              <p className="text-slate-600 mb-4">
                Create {moduleNameSingular.toLowerCase()} profiles to assign to events
              </p>
              <Button
                onClick={() => handleOpenEditor()}
                className="bg-blue-600 hover:bg-blue-700 gap-2"
                data-testid="button-add-first-speaker"
              >
                <Plus className="w-4 h-4" />
                Add First {moduleNameSingular}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {speakers.map((speaker) => (
              <Card key={speaker.id} className="border-slate-200 shadow-sm hover:shadow-md transition-shadow" data-testid={`card-speaker-${speaker.id}`}>
                <CardContent className="p-6">
                  <div className="flex items-start gap-4 mb-4">
                    {speaker.profile_photo_url ? (
                      <img
                        src={speaker.profile_photo_url}
                        alt={speaker.full_name}
                        className="w-16 h-16 rounded-full object-cover border-2 border-slate-200"
                      />
                    ) : (
                      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                        <Mic className="w-8 h-8 text-white" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-slate-900 mb-1" data-testid={`text-speaker-name-${speaker.id}`}>
                        {speaker.full_name}
                      </h3>
                      {!speaker.is_active && (
                        <span className="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full">
                          Inactive
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 mb-4">
                    {speaker.job_title && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Briefcase className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{speaker.job_title}</span>
                      </div>
                    )}
                    {speaker.organization && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Building className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{speaker.organization}</span>
                      </div>
                    )}
                    {speaker.email && (
                      <div className="flex items-center gap-2 text-sm text-slate-600">
                        <Mail className="w-4 h-4 flex-shrink-0" />
                        <span className="truncate">{speaker.email}</span>
                      </div>
                    )}
                  </div>

                  {speaker.biography && (
                    <p className="text-sm text-slate-600 line-clamp-3 mb-4">
                      {speaker.biography}
                    </p>
                  )}

                  <div className="flex gap-2 pt-4 border-t border-slate-200">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleOpenEditor(speaker)}
                      className="flex-1 gap-2"
                      data-testid={`button-edit-speaker-${speaker.id}`}
                    >
                      <Edit className="w-4 h-4" />
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeleteClick(speaker)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      data-testid={`button-delete-speaker-${speaker.id}`}
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
                {editingSpeaker ? `Edit ${moduleNameSingular}` : `Add ${moduleNameSingular}`}
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
                      <Mic className="w-12 h-12 text-slate-400" />
                    </div>
                  )}
                  <div>
                    <input
                      type="file"
                      id="speaker-photo-upload"
                      accept="image/*"
                      onChange={handlePhotoUpload}
                      className="hidden"
                      disabled={isUploading}
                    />
                    <Label htmlFor="speaker-photo-upload">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={isUploading}
                        className="gap-2 cursor-pointer"
                        onClick={() => document.getElementById('speaker-photo-upload').click()}
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
                  data-testid="input-speaker-name"
                />
              </div>

              {/* Email */}
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john.smith@example.com"
                  data-testid="input-speaker-email"
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
                  data-testid="input-speaker-job-title"
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
                  data-testid="input-speaker-organization"
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
                  data-testid="input-speaker-biography"
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
                  data-testid="checkbox-speaker-active"
                />
                <Label htmlFor="is_active" className="cursor-pointer">
                  Active (available for event assignment)
                </Label>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleCloseEditor}
                data-testid="button-cancel-speaker"
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={saveMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-speaker"
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
              <AlertDialogTitle>Delete {moduleNameSingular}</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to delete {speakerToDelete?.full_name}? This action cannot be undone.
                Events with this {moduleNameSingular.toLowerCase()} assigned will need to be updated.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-delete-speaker">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDeleteConfirm}
                className="bg-red-600 hover:bg-red-700"
                data-testid="button-confirm-delete-speaker"
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
