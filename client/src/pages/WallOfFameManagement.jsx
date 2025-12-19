import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Trophy, Plus, Pencil, Trash2, Users, Folder, User, Upload, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function WallOfFameManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [activeTab, setActiveTab] = useState("sections");
  const [editingSection, setEditingSection] = useState(null);
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingPerson, setEditingPerson] = useState(null);
  const [showSectionDialog, setShowSectionDialog] = useState(false);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [showPersonDialog, setShowPersonDialog] = useState(false);
  const [selectedSectionForCategory, setSelectedSectionForCategory] = useState(null);
  const [selectedCategoryForPerson, setSelectedCategoryForPerson] = useState(null);
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState({});
  const [profilePhotoSize, setProfilePhotoSize] = useState("medium");
  const [selectedOrganizationForMember, setSelectedOrganizationForMember] = useState("");
  const [memberSearchQuery, setMemberSearchQuery] = useState("");

  const queryClient = useQueryClient();

  const { data: sections = [], isLoading: sectionsLoading } = useQuery({
    queryKey: ['wall-of-fame-sections'],
    queryFn: () => base44.entities.WallOfFameSection.list(),
  });

  const { data: categories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['wall-of-fame-categories'],
    queryFn: () => base44.entities.WallOfFameCategory.list(),
  });

  const { data: people = [], isLoading: peopleLoading } = useQuery({
    queryKey: ['wall-of-fame-people'],
    queryFn: () => base44.entities.WallOfFamePerson.list(),
  });

  // Fetch organizations when person dialog is open
  const { data: organizations = [], isLoading: organizationsLoading } = useQuery({
    queryKey: ['organizations-for-member-selection'],
    queryFn: async () => {
      const orgs = await base44.entities.Organization.list({ limit: 5000 });
      return orgs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },
    enabled: showPersonDialog
  });

  // Fetch members filtered by selected organization
  const { data: members = [], isLoading: membersLoading } = useQuery({
    queryKey: ['members-for-selection', selectedOrganizationForMember],
    queryFn: async () => {
      if (selectedOrganizationForMember === '__no_org__') {
        // Fetch members without an organization
        const allMembers = await base44.entities.Member.list({ limit: 5000 });
        return allMembers.filter(m => !m.organization_id);
      } else if (selectedOrganizationForMember) {
        // Fetch members for the selected organization
        return await base44.entities.Member.list({ 
          filter: { organization_id: selectedOrganizationForMember },
          limit: 1000
        });
      }
      return [];
    },
    enabled: showPersonDialog && !!selectedOrganizationForMember
  });

  const { data: photoSizeSetting } = useQuery({
    queryKey: ['wall-of-fame-photo-size'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      const setting = allSettings.find(s => s.setting_key === 'wall_of_fame_photo_size');
      return setting ? { id: setting.id, value: setting.setting_value } : null;
    },
    staleTime: 0,
    refetchOnMount: true
  });

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_WallOfFameManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  useEffect(() => {
    if (photoSizeSetting?.value) {
      setProfilePhotoSize(photoSizeSetting.value);
    }
  }, [photoSizeSetting]);

  const sectionMutation = useMutation({
    mutationFn: ({ id, data }) => id ? base44.entities.WallOfFameSection.update(id, data) : base44.entities.WallOfFameSection.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wall-of-fame-sections'] });
      setShowSectionDialog(false);
      setEditingSection(null);
      toast.success('Section saved successfully');
    },
  });

  const categoryMutation = useMutation({
    mutationFn: ({ id, data }) => id ? base44.entities.WallOfFameCategory.update(id, data) : base44.entities.WallOfFameCategory.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wall-of-fame-categories'] });
      setShowCategoryDialog(false);
      setEditingCategory(null);
      toast.success('Category saved successfully');
    },
  });

  const personMutation = useMutation({
    mutationFn: ({ id, data }) => id ? base44.entities.WallOfFamePerson.update(id, data) : base44.entities.WallOfFamePerson.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wall-of-fame-people'] });
      setShowPersonDialog(false);
      setEditingPerson(null);
      toast.success('Person saved successfully');
    },
  });

  const deleteSectionMutation = useMutation({
    mutationFn: (id) => base44.entities.WallOfFameSection.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wall-of-fame-sections'] });
      toast.success('Section deleted');
    },
  });

  const deleteCategoryMutation = useMutation({
    mutationFn: (id) => base44.entities.WallOfFameCategory.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wall-of-fame-categories'] });
      toast.success('Category deleted');
    },
  });

  const deletePersonMutation = useMutation({
    mutationFn: (id) => base44.entities.WallOfFamePerson.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wall-of-fame-people'] });
      toast.success('Person deleted');
    },
  });

  const savePhotoSizeMutation = useMutation({
    mutationFn: async (size) => {
      if (photoSizeSetting?.id) {
        return await base44.entities.SystemSettings.update(photoSizeSetting.id, {
          setting_value: size
        });
      } else {
        return await base44.entities.SystemSettings.create({
          setting_key: 'wall_of_fame_photo_size',
          setting_value: size,
          description: 'Profile photo size for Wall of Fame display (small, medium, large)'
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wall-of-fame-photo-size'] });
      toast.success('Photo size setting saved');
    },
  });

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }

    setIsUploadingPhoto(true);
    try {
      const result = await base44.integrations.Core.UploadFile({ file });
      setEditingPerson({ ...editingPerson, profile_photo_url: result.file_url });
      toast.success('Photo uploaded');
    } catch (error) {
      toast.error('Failed to upload photo');
    } finally {
      setIsUploadingPhoto(false);
    }
  };

  const handleMemberSelect = (memberId) => {
    const member = members.find(m => m.id === memberId);
    if (member) {
      setEditingPerson({
        ...editingPerson,
        member_id: memberId,
        first_name: member.first_name || '',
        last_name: member.last_name || '',
        job_title: member.job_title || '',
        biography: member.biography || '',
        profile_photo_url: member.profile_photo_url || '',
        linkedin_url: member.linkedin_url || '',
        email: member.email || ''
      });
    }
  };

  const sortedSections = [...sections].sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Wall of Fame Management
            </h1>
            <p className="text-slate-600">
              Manage sections, categories, and people for public display
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="sections">Sections</TabsTrigger>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="sections">
            <div className="mb-4">
              <Button onClick={() => { setEditingSection({ name: '', description: '', display_order: 0, is_active: true }); setShowSectionDialog(true); }} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Add Section
              </Button>
            </div>

            {sectionsLoading ? (
              <div className="text-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" /></div>
            ) : sortedSections.length === 0 ? (
              <Card className="border-slate-200">
                <CardContent className="p-12 text-center">
                  <Folder className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                  <h3 className="text-xl font-semibold text-slate-900 mb-2">No Sections Yet</h3>
                  <p className="text-slate-600">Create your first section to get started</p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4">
                {sortedSections.map(section => (
                  <Card key={section.id} className="border-slate-200">
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <CardTitle className="flex items-center gap-2">
                            <Trophy className="w-5 h-5 text-blue-600" />
                            {section.name}
                          </CardTitle>
                          {section.description && <p className="text-sm text-slate-600 mt-1">{section.description}</p>}
                          <div className="flex gap-2 mt-2">
                            <Badge variant={section.is_active ? "default" : "secondary"}>
                              {section.is_active ? 'Active' : 'Inactive'}
                            </Badge>
                            <Badge variant="outline">Order: {section.display_order}</Badge>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => { setEditingSection(section); setShowSectionDialog(true); }}>
                            <Pencil className="w-3 h-3" />
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => deleteSectionMutation.mutate(section.id)} className="text-red-600">
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="categories">
            <div className="mb-4">
              <Button onClick={() => { setEditingCategory({ section_id: '', name: '', description: '', display_order: 0, is_active: true }); setShowCategoryDialog(true); }} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Add Category
              </Button>
            </div>

            {categoriesLoading ? (
              <div className="text-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" /></div>
            ) : (
              <div className="space-y-6">
                {sortedSections.map(section => {
                  const sectionCategories = categories.filter(c => c.section_id === section.id).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
                  return (
                    <Card key={section.id} className="border-slate-200">
                      <CardHeader>
                        <CardTitle className="text-lg">{section.name}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {sectionCategories.length === 0 ? (
                          <p className="text-slate-500 text-sm">No categories yet</p>
                        ) : (
                          <div className="space-y-2">
                            {sectionCategories.map(category => (
                              <div key={category.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <Users className="w-4 h-4 text-blue-600" />
                                    <span className="font-medium">{category.name}</span>
                                    <Badge variant={category.is_active ? "default" : "secondary"} className="text-xs">
                                      {category.is_active ? 'Active' : 'Inactive'}
                                    </Badge>
                                  </div>
                                  {category.description && <p className="text-xs text-slate-600 mt-1 ml-6">{category.description}</p>}
                                </div>
                                <div className="flex gap-2">
                                  <Button variant="ghost" size="sm" onClick={() => { setEditingCategory(category); setShowCategoryDialog(true); }}>
                                    <Pencil className="w-3 h-3" />
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={() => deleteCategoryMutation.mutate(category.id)} className="text-red-600">
                                    <Trash2 className="w-3 h-3" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="people">
            <div className="mb-4">
              <Button onClick={() => { setEditingPerson({ category_id: '', first_name: '', last_name: '', job_title: '', biography: '', profile_photo_url: '', linkedin_url: '', email: '', display_order: 0, is_active: true }); setSelectedOrganizationForMember(''); setMemberSearchQuery(''); setShowPersonDialog(true); }} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Add Person
              </Button>
            </div>

            {peopleLoading ? (
              <div className="text-center py-12"><Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto" /></div>
            ) : (
              <div className="space-y-6">
                {sortedSections.map(section => {
                  const sectionCategories = categories.filter(c => c.section_id === section.id).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
                  if (sectionCategories.length === 0) return null;

                  return (
                    <Card key={section.id} className="border-slate-200">
                      <CardHeader>
                        <CardTitle className="text-lg">{section.name}</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {sectionCategories.map(category => {
                          const categoryPeople = people.filter(p => p.category_id === category.id).sort((a, b) => (a.display_order || 0) - (b.display_order || 0));
                          const isExpanded = expandedCategories[category.id];

                          return (
                            <div key={category.id} className="border border-slate-200 rounded-lg">
                              <div className="flex items-center justify-between p-3 bg-slate-50 cursor-pointer" onClick={() => setExpandedCategories({ ...expandedCategories, [category.id]: !isExpanded })}>
                                <div className="flex items-center gap-2">
                                  <Users className="w-4 h-4 text-blue-600" />
                                  <span className="font-medium">{category.name}</span>
                                  <Badge variant="secondary">{categoryPeople.length}</Badge>
                                </div>
                                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                              </div>
                              {isExpanded && (
                                <div className="p-3 space-y-2">
                                  {categoryPeople.length === 0 ? (
                                    <p className="text-slate-500 text-sm">No people yet</p>
                                  ) : (
                                    categoryPeople.map(person => (
                                      <div key={person.id} className="flex items-center gap-3 p-3 bg-white rounded border border-slate-200">
                                        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden flex-shrink-0">
                                          {person.profile_photo_url ? (
                                            <img src={person.profile_photo_url} alt={`${person.first_name} ${person.last_name}`} className="w-full h-full object-cover" />
                                          ) : (
                                            <User className="w-6 h-6 text-slate-400" />
                                          )}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <div className="font-medium">{person.first_name} {person.last_name}</div>
                                          {person.job_title && <div className="text-sm text-slate-600">{person.job_title}</div>}
                                          {person.member_id && <Badge variant="outline" className="text-xs mt-1">Linked Member</Badge>}
                                        </div>
                                        <div className="flex gap-2">
                                          <Button variant="ghost" size="sm" onClick={() => { setEditingPerson(person); setSelectedOrganizationForMember(''); setMemberSearchQuery(''); setShowPersonDialog(true); }}>
                                            <Pencil className="w-3 h-3" />
                                          </Button>
                                          <Button variant="ghost" size="sm" onClick={() => deletePersonMutation.mutate(person.id)} className="text-red-600">
                                            <Trash2 className="w-3 h-3" />
                                          </Button>
                                        </div>
                                      </div>
                                    ))
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="settings">
            <Card className="border-slate-200">
              <CardHeader>
                <CardTitle>Display Settings</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-3">
                  <Label className="text-base font-semibold">Profile Photo Size</Label>
                  <p className="text-sm text-slate-600">
                    Choose the size of profile photos displayed on the public Wall of Fame
                  </p>
                  <Select 
                    value={profilePhotoSize} 
                    onValueChange={(value) => {
                      setProfilePhotoSize(value);
                      savePhotoSizeMutation.mutate(value);
                    }}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="small">Small</SelectItem>
                      <SelectItem value="medium">Medium (Default)</SelectItem>
                      <SelectItem value="large">Large</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Section Dialog */}
        <Dialog open={showSectionDialog} onOpenChange={setShowSectionDialog}>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{editingSection?.id ? 'Edit Section' : 'Create Section'}</DialogTitle>
            </DialogHeader>
            {editingSection && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input value={editingSection.name} onChange={(e) => setEditingSection({ ...editingSection, name: e.target.value })} placeholder="e.g., Our Team" />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea value={editingSection.description || ''} onChange={(e) => setEditingSection({ ...editingSection, description: e.target.value })} placeholder="Optional description" rows={3} />
                </div>
                <div className="space-y-2">
                  <Label>Display Order</Label>
                  <Input type="number" value={editingSection.display_order} onChange={(e) => setEditingSection({ ...editingSection, display_order: parseInt(e.target.value) })} />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowSectionDialog(false)}>Cancel</Button>
              <Button onClick={() => sectionMutation.mutate({ id: editingSection?.id, data: editingSection })} disabled={sectionMutation.isPending}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Category Dialog */}
        <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
          <DialogContent aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{editingCategory?.id ? 'Edit Category' : 'Create Category'}</DialogTitle>
            </DialogHeader>
            {editingCategory && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Section *</Label>
                  <Select value={editingCategory.section_id} onValueChange={(value) => setEditingCategory({ ...editingCategory, section_id: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select section" />
                    </SelectTrigger>
                    <SelectContent>
                      {sections.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Name *</Label>
                  <Input value={editingCategory.name} onChange={(e) => setEditingCategory({ ...editingCategory, name: e.target.value })} placeholder="e.g., Staff, Board" />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea value={editingCategory.description || ''} onChange={(e) => setEditingCategory({ ...editingCategory, description: e.target.value })} placeholder="Optional description" rows={2} />
                </div>
                <div className="space-y-2">
                  <Label>Display Order</Label>
                  <Input type="number" value={editingCategory.display_order} onChange={(e) => setEditingCategory({ ...editingCategory, display_order: parseInt(e.target.value) })} />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCategoryDialog(false)}>Cancel</Button>
              <Button onClick={() => categoryMutation.mutate({ id: editingCategory?.id, data: editingCategory })} disabled={categoryMutation.isPending}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Person Dialog */}
        <Dialog open={showPersonDialog} onOpenChange={(open) => { 
          setShowPersonDialog(open); 
          if (!open) { 
            setSelectedOrganizationForMember(''); 
            setMemberSearchQuery(''); 
          } 
        }}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>{editingPerson?.id ? 'Edit Person' : 'Add Person'}</DialogTitle>
            </DialogHeader>
            {editingPerson && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Category *</Label>
                  <Select value={editingPerson.category_id} onValueChange={(value) => setEditingPerson({ ...editingPerson, category_id: value })}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name} ({sections.find(s => s.id === c.section_id)?.name})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                {/* Step 1: Select Organization */}
                <div className="space-y-2">
                  <Label>Step 1: Select Organisation (to link member)</Label>
                  <Select 
                    value={selectedOrganizationForMember} 
                    onValueChange={(value) => {
                      setSelectedOrganizationForMember(value);
                      setMemberSearchQuery("");
                      setEditingPerson({ ...editingPerson, member_id: null });
                    }}
                  >
                    <SelectTrigger data-testid="select-organization-for-member">
                      <SelectValue placeholder={organizationsLoading ? "Loading organisations..." : "Select an organisation first..."} />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      <SelectItem value="__skip__">Skip - Create ad-hoc entry</SelectItem>
                      <SelectItem value="__no_org__">Members without organisation</SelectItem>
                      {organizations.map(org => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Step 2: Select Member (only shown after organization is selected) */}
                {selectedOrganizationForMember && selectedOrganizationForMember !== '__skip__' && (
                  <div className="space-y-2">
                    <Label>Step 2: Search & Select Member</Label>
                    <Input
                      value={memberSearchQuery}
                      onChange={(e) => setMemberSearchQuery(e.target.value)}
                      placeholder="Search by name or email..."
                      data-testid="input-member-search"
                    />
                    <div className="border border-slate-200 rounded-lg max-h-[200px] overflow-y-auto">
                      {membersLoading ? (
                        <div className="p-4 text-center text-slate-500">
                          <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
                          Loading members...
                        </div>
                      ) : members.length === 0 ? (
                        <div className="p-4 text-center text-slate-500">
                          No members found in this organisation
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-200">
                          {members
                            .filter(m => {
                              if (!memberSearchQuery) return true;
                              const search = memberSearchQuery.toLowerCase();
                              return (
                                m.first_name?.toLowerCase().includes(search) ||
                                m.last_name?.toLowerCase().includes(search) ||
                                m.email?.toLowerCase().includes(search)
                              );
                            })
                            .map(member => (
                              <button
                                key={member.id}
                                type="button"
                                onClick={() => handleMemberSelect(member.id)}
                                className={`w-full p-3 text-left hover:bg-slate-50 transition-colors ${
                                  editingPerson.member_id === member.id ? 'bg-blue-50 hover:bg-blue-100' : ''
                                }`}
                                data-testid={`button-select-member-${member.id}`}
                              >
                                <div className="font-medium text-sm">
                                  {member.first_name} {member.last_name}
                                </div>
                                <div className="text-xs text-slate-500">{member.email}</div>
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                    {editingPerson.member_id && (
                      <div className="flex items-center gap-2 p-2 bg-green-50 rounded border border-green-200">
                        <User className="w-4 h-4 text-green-600" />
                        <span className="text-sm text-green-700">
                          Member linked: {members.find(m => m.id === editingPerson.member_id)?.first_name} {members.find(m => m.id === editingPerson.member_id)?.last_name}
                        </span>
                        <Button 
                          type="button" 
                          variant="ghost" 
                          size="sm" 
                          className="ml-auto h-6 text-xs"
                          onClick={() => setEditingPerson({ ...editingPerson, member_id: null })}
                        >
                          Clear
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>First Name *</Label>
                    <Input value={editingPerson.first_name || ''} onChange={(e) => setEditingPerson({ ...editingPerson, first_name: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>Last Name *</Label>
                    <Input value={editingPerson.last_name || ''} onChange={(e) => setEditingPerson({ ...editingPerson, last_name: e.target.value })} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Job Title</Label>
                  <Input value={editingPerson.job_title || ''} onChange={(e) => setEditingPerson({ ...editingPerson, job_title: e.target.value })} placeholder="e.g., Chief Executive Officer" />
                </div>

                <div className="space-y-2">
                  <Label>Secondary Organisation</Label>
                  <Input value={editingPerson.secondary_organisation || ''} onChange={(e) => setEditingPerson({ ...editingPerson, secondary_organisation: e.target.value })} placeholder="Optional secondary organisation" />
                </div>

                <div className="space-y-2">
                  <Label>Secondary Job Title</Label>
                  <Input value={editingPerson.secondary_job_title || ''} onChange={(e) => setEditingPerson({ ...editingPerson, secondary_job_title: e.target.value })} placeholder="Optional secondary job title" />
                </div>

                <div className="space-y-2">
                  <Label>Biography</Label>
                  <Textarea value={editingPerson.biography || ''} onChange={(e) => setEditingPerson({ ...editingPerson, biography: e.target.value })} placeholder="Full biography" rows={5} />
                </div>

                <div className="space-y-2">
                  <Label>Profile Photo</Label>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden">
                      {editingPerson.profile_photo_url ? (
                        <img src={editingPerson.profile_photo_url} alt="Profile" className="w-full h-full object-cover" />
                      ) : (
                        <User className="w-8 h-8 text-slate-400" />
                      )}
                    </div>
                    <input type="file" id="photo-upload" accept="image/*" onChange={handlePhotoUpload} className="hidden" />
                    <Button type="button" variant="outline" disabled={isUploadingPhoto} onClick={() => document.getElementById('photo-upload').click()}>
                      {isUploadingPhoto ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Uploading...</> : <><Upload className="w-4 h-4 mr-2" />Upload Photo</>}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>LinkedIn URL</Label>
                  <Input type="url" value={editingPerson.linkedin_url || ''} onChange={(e) => setEditingPerson({ ...editingPerson, linkedin_url: e.target.value })} placeholder="https://linkedin.com/in/..." />
                </div>

                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input type="email" value={editingPerson.email || ''} onChange={(e) => setEditingPerson({ ...editingPerson, email: e.target.value })} placeholder="email@example.com" />
                </div>

                <div className="space-y-2">
                  <Label>Display Order</Label>
                  <Input type="number" value={editingPerson.display_order} onChange={(e) => setEditingPerson({ ...editingPerson, display_order: parseInt(e.target.value) })} />
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowPersonDialog(false)}>Cancel</Button>
              <Button onClick={() => personMutation.mutate({ id: editingPerson?.id, data: editingPerson })} disabled={personMutation.isPending}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}