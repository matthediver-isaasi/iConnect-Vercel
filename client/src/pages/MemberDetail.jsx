import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useState, useEffect, useMemo } from "react";
import { supabase } from "@/api/supabaseClient";
import { Loader2, ArrowLeft, User, Pencil, Save, X, Building2, Mail, Smartphone, PhoneCall, Briefcase, Shield, CalendarDays, LogIn, Users, Globe, ClipboardList, Calendar, FolderTree, Trophy, StickyNote, Plus, Search, MessageSquare, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import MemberEmails from "@/components/MemberEmails";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
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
import { useDateFormat } from "@/hooks/useDateFormat";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export default function MemberDetail() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const { isAdmin, isAccessReady } = useMemberAccess();
  const { formatDate } = useDateFormat();

  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    mobile: '',
    landline: '',
    job_title: '',
    biography: '',
    organization_id: '',
    login_enabled: true,
    show_in_directory: true
  });
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [isSavingCategories, setIsSavingCategories] = useState(false);
  const [openingBalances, setOpeningBalances] = useState({
    eventsAttended: 0,
    articlesPublished: 0,
    jobsPosted: 0,
    awards: 0,
    engagementAwards: 0
  });
  const [isSavingBalances, setIsSavingBalances] = useState(false);
  
  // Notes state
  const [newNoteContent, setNewNoteContent] = useState('');
  const [noteSearchTerm, setNoteSearchTerm] = useState('');
  const [notesPage, setNotesPage] = useState(1);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteContent, setEditingNoteContent] = useState('');
  const [noteToDelete, setNoteToDelete] = useState(null);
  const notesPerPage = 10;
  
  // Communications state
  const [updatingCommPrefs, setUpdatingCommPrefs] = useState(new Set());

  // Data queries
  const { data: member, isLoading: memberLoading } = useQuery({
    queryKey: ['member-detail', id],
    enabled: isAccessReady && !!id,
    queryFn: () => base44.entities.Member.get(id)
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations-for-member-detail'],
    enabled: isAccessReady,
    queryFn: () => base44.entities.Organization.list('name')
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-member-detail'],
    enabled: isAccessReady,
    queryFn: () => base44.entities.Role.list()
  });

  // Activity tab queries
  const { data: memberBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['member-detail-bookings', id],
    enabled: !!id && activeTab === 'activity',
    queryFn: async () => {
      try {
        const bookings = await base44.entities.Booking.list({ filter: { member_id: id } });
        return (bookings || []).sort((a, b) => 
          new Date(b.created_date || 0) - new Date(a.created_date || 0)
        ).slice(0, 20);
      } catch {
        return [];
      }
    }
  });

  const { data: events = [] } = useQuery({
    queryKey: ['events-for-member-detail'],
    enabled: activeTab === 'activity' && memberBookings.length > 0,
    queryFn: () => base44.entities.Event.list()
  });

  // Categories tab queries
  const { data: resourceCategories = [], isLoading: categoriesLoading } = useQuery({
    queryKey: ['resource-categories-for-member-detail'],
    enabled: activeTab === 'categories',
    queryFn: async () => {
      try {
        const categories = await base44.entities.ResourceCategory.list({
          filter: { is_active: true }
        });
        return categories || [];
      } catch {
        return [];
      }
    }
  });

  const { data: memberCategorySelections = [], isLoading: selectionsLoading } = useQuery({
    queryKey: ['member-resource-categories', id],
    enabled: !!id && activeTab === 'categories',
    queryFn: async () => {
      try {
        const response = await fetch(`/api/members/${id}/categories`, {
          credentials: 'include'
        });
        if (!response.ok) return [];
        return await response.json();
      } catch {
        return [];
      }
    }
  });

  // Notes query
  const { data: memberNotes = [], isLoading: notesLoading } = useQuery({
    queryKey: ['member-notes', id],
    enabled: !!id && activeTab === 'notes',
    queryFn: async () => {
      const res = await fetch(`/api/admin/members/${id}/notes`, {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to fetch notes');
      return res.json();
    }
  });

  // Notes mutations
  const createNoteMutation = useMutation({
    mutationFn: async ({ content }) => {
      const res = await fetch(`/api/admin/members/${id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error('Failed to create note');
      return res.json();
    },
    onSuccess: () => {
      setNewNoteContent('');
      queryClient.invalidateQueries({ queryKey: ['member-notes', id] });
      toast.success('Note added');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to create note');
    }
  });

  const updateNoteMutation = useMutation({
    mutationFn: async ({ noteId, content }) => {
      const res = await fetch(`/api/admin/member-notes/${noteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content })
      });
      if (!res.ok) throw new Error('Failed to update note');
      return res.json();
    },
    onSuccess: () => {
      setEditingNoteId(null);
      setEditingNoteContent('');
      queryClient.invalidateQueries({ queryKey: ['member-notes', id] });
      toast.success('Note updated');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to update note');
    }
  });

  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId) => {
      const res = await fetch(`/api/admin/member-notes/${noteId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Failed to delete note');
      return res.json();
    },
    onSuccess: () => {
      setNoteToDelete(null);
      queryClient.invalidateQueries({ queryKey: ['member-notes', id] });
      toast.success('Note deleted');
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to delete note');
    }
  });

  // Communication categories and preferences
  const { data: communicationCategories = [], isLoading: communicationCategoriesLoading } = useQuery({
    queryKey: ["communicationCategories"],
    enabled: activeTab === 'communications',
    queryFn: async () => {
      const { data, error } = await supabase
        .from("communication_category")
        .select(`
          *,
          communication_category_role(role_id)
        `)
        .eq("is_active", true)
        .order("display_order", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: communicationPreferences = [] } = useQuery({
    queryKey: ["communicationPreferences", id],
    enabled: !!id && activeTab === 'communications',
    queryFn: async () => {
      if (!id) return [];
      const { data, error } = await supabase
        .from("member_communication_preference")
        .select("*")
        .eq("member_id", id);
      if (error) throw error;
      return data || [];
    },
  });

  const memberRoleIds = useMemo(() => {
    const roleId = formData.role_id || member?.role_id;
    if (!roleId) return [];
    if (Array.isArray(roleId)) return roleId;
    return [roleId];
  }, [formData.role_id, member?.role_id]);

  const availableCommCategories = useMemo(() => {
    if (!communicationCategories.length) return [];
    
    return communicationCategories.filter(category => {
      if (!category.communication_category_role?.length) return true;
      const categoryRoleIds = category.communication_category_role.map(r => r.role_id);
      return memberRoleIds.some(roleId => categoryRoleIds.includes(roleId));
    });
  }, [communicationCategories, memberRoleIds]);

  const handleCommunicationToggle = async (categoryId, isSubscribed) => {
    if (!member?.id) return;
    
    setUpdatingCommPrefs(prev => new Set(prev).add(categoryId));
    
    try {
      const response = await fetch(
        `/api/admin/members/${member.id}/communication-preferences/${categoryId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ is_subscribed: isSubscribed }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update preference');
      }
      
      queryClient.invalidateQueries({ queryKey: ["communicationPreferences", id] });
      toast.success(isSubscribed ? "Subscribed to updates" : "Unsubscribed from updates");
    } catch (error) {
      console.error("Failed to update communication preference:", error);
      toast.error(error.message || "Failed to update preference");
    } finally {
      setUpdatingCommPrefs(prev => {
        const next = new Set(prev);
        next.delete(categoryId);
        return next;
      });
    }
  };

  // Sync formData with member
  useEffect(() => {
    if (member?.id && !isEditing) {
      setFormData({
        first_name: member.first_name || '',
        last_name: member.last_name || '',
        email: member.email || '',
        mobile: member.mobile || '',
        landline: member.landline || '',
        job_title: member.job_title || '',
        biography: member.biography || '',
        organization_id: member.organization_id || '',
        login_enabled: member.login_enabled !== false,
        show_in_directory: member.show_in_directory !== false
      });
      setSelectedRoleId(member.role_id || null);
    }
  }, [member, isEditing]);

  // Sync category selections when data loads
  useEffect(() => {
    if (memberCategorySelections.length > 0) {
      setSelectedSubcategories(memberCategorySelections.map(s => ({
        category_id: s.category_id,
        subcategory_name: s.subcategory_name || null
      })));
    }
  }, [memberCategorySelections]);

  // Sync opening balances from member data
  useEffect(() => {
    if (member?.opening_balances) {
      const ob = member.opening_balances;
      setOpeningBalances({
        eventsAttended: ob.eventsAttended || 0,
        articlesPublished: ob.articlesPublished || 0,
        jobsPosted: ob.jobsPosted || 0,
        awards: ob.awards || 0,
        engagementAwards: ob.engagementAwards || 0
      });
    }
  }, [member?.opening_balances]);

  // Mutation
  const updateMutation = useMutation({
    mutationFn: (data) => base44.entities.Member.update(id, data),
    onSuccess: () => {
      toast.success("Member updated successfully");
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ['members-paginated'] });
      queryClient.invalidateQueries({ queryKey: ['member-detail', id] });
    },
    onError: (error) => {
      toast.error("Failed to update member: " + (error.message || "Unknown error"));
    }
  });

  // Helpers
  const getMemberName = (m) => [m?.first_name, m?.last_name].filter(Boolean).join(' ') || '';
  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };
  const getOrganization = () => organizations.find(o => o.id === member?.organization_id);
  const getRoleName = (roleId) => roles.find(r => r.id === roleId)?.name || roleId;

  // Category helpers
  const isSubcategorySelected = (categoryId, subcategoryName) => {
    return selectedSubcategories.some(s => 
      s.category_id === categoryId && s.subcategory_name === subcategoryName
    );
  };

  const toggleSubcategory = (categoryId, subcategoryName) => {
    setSelectedSubcategories(prev => {
      const exists = prev.some(s => 
        s.category_id === categoryId && s.subcategory_name === subcategoryName
      );
      if (exists) {
        return prev.filter(s => 
          !(s.category_id === categoryId && s.subcategory_name === subcategoryName)
        );
      } else {
        return [...prev, { category_id: categoryId, subcategory_name: subcategoryName }];
      }
    });
  };

  const handleSaveCategories = async () => {
    if (!member?.id) return;
    setIsSavingCategories(true);
    try {
      const response = await fetch(`/api/members/${member.id}/categories`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ selections: selectedSubcategories })
      });
      if (!response.ok) throw new Error('Failed to save');
      toast.success('Category preferences saved');
      queryClient.invalidateQueries({ queryKey: ['member-resource-categories', id] });
    } catch (error) {
      toast.error('Failed to save category preferences');
    } finally {
      setIsSavingCategories(false);
    }
  };

  const handleSaveOpeningBalances = async () => {
    if (!member?.id) return;
    setIsSavingBalances(true);
    try {
      await base44.entities.Member.update(member.id, {
        opening_balances: openingBalances
      });
      toast.success('Opening balances saved');
      queryClient.invalidateQueries({ queryKey: ['member-detail', id] });
    } catch (error) {
      toast.error('Failed to save opening balances');
    } finally {
      setIsSavingBalances(false);
    }
  };

  // Handlers
  const handleSave = () => {
    updateMutation.mutate({ ...formData, role_id: selectedRoleId });
  };

  const handleCancel = () => {
    setFormData({
      first_name: member.first_name || '',
      last_name: member.last_name || '',
      email: member.email || '',
      mobile: member.mobile || '',
      landline: member.landline || '',
      job_title: member.job_title || '',
      biography: member.biography || '',
      organization_id: member.organization_id || '',
      login_enabled: member.login_enabled !== false,
      show_in_directory: member.show_in_directory !== false
    });
    setSelectedRoleId(member.role_id || null);
    setIsEditing(false);
  };

  if (memberLoading || !member) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const org = getOrganization();

  return (
    <div className="p-6 space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/members" data-testid="link-back-to-members">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <Avatar className="h-12 w-12">
              <AvatarImage src={member?.profile_photo} />
              <AvatarFallback className="bg-blue-100 text-blue-700">
                {getInitials(getMemberName(member))}
              </AvatarFallback>
            </Avatar>
            <div>
              <h1 className="text-xl font-semibold text-slate-900">
                {getMemberName(member) || 'Unknown Member'}
              </h1>
              <p className="text-sm text-slate-500 flex items-center gap-2">
                {member?.job_title && <span>{member.job_title}</span>}
                {member?.job_title && org && <span>•</span>}
                {org && <span>{org.name}</span>}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {member?.login_enabled === false ? (
            <Badge variant="secondary" className="bg-red-100 text-red-700">Login Disabled</Badge>
          ) : (
            <Badge variant="secondary" className="bg-green-100 text-green-700">Active</Badge>
          )}
          {isAdmin && !isEditing && (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-member">
              <Pencil className="w-4 h-4 mr-1" />
              Edit
            </Button>
          )}
          {isEditing && (
            <>
              <Button variant="ghost" size="sm" onClick={handleCancel} data-testid="button-cancel-edit-member">
                <X className="w-4 h-4 mr-1" />
                Cancel
              </Button>
              <Button 
                size="sm" 
                onClick={handleSave} 
                disabled={updateMutation.isPending} 
                data-testid="button-save-member"
              >
                {updateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Save className="w-4 h-4 mr-1" />
                )}
                Save
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview" className="gap-1" data-testid="tab-member-overview">
            <User className="w-4 h-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="activity" className="gap-1" data-testid="tab-member-activity">
            <ClipboardList className="w-4 h-4" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="roles" className="gap-1" data-testid="tab-member-roles">
            <Shield className="w-4 h-4" />
            Roles
          </TabsTrigger>
          <TabsTrigger value="categories" className="gap-1" data-testid="tab-member-categories">
            <FolderTree className="w-4 h-4" />
            Categories
          </TabsTrigger>
          <TabsTrigger value="balances" className="gap-1" data-testid="tab-member-balances">
            <Trophy className="w-4 h-4" />
            Balances
          </TabsTrigger>
          <TabsTrigger value="notes" className="gap-1" data-testid="tab-member-notes">
            <StickyNote className="w-4 h-4" />
            Notes
          </TabsTrigger>
          <TabsTrigger value="communications" className="gap-1" data-testid="tab-member-communications">
            <Mail className="w-4 h-4" />
            Communications
          </TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Contact Information Card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <User className="w-5 h-5 text-blue-600" />
                  Contact Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {isEditing ? (
                  <>
                    <div className="space-y-2">
                      <Label>First Name</Label>
                      <Input
                        value={formData.first_name}
                        onChange={(e) => setFormData(prev => ({ ...prev, first_name: e.target.value }))}
                        data-testid="input-member-first-name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Last Name</Label>
                      <Input
                        value={formData.last_name}
                        onChange={(e) => setFormData(prev => ({ ...prev, last_name: e.target.value }))}
                        data-testid="input-member-last-name"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Email</Label>
                      <Input
                        type="email"
                        value={formData.email}
                        onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                        data-testid="input-member-email"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Mobile</Label>
                      <Input
                        value={formData.mobile}
                        onChange={(e) => setFormData(prev => ({ ...prev, mobile: e.target.value }))}
                        data-testid="input-member-mobile"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Landline</Label>
                      <Input
                        value={formData.landline}
                        onChange={(e) => setFormData(prev => ({ ...prev, landline: e.target.value }))}
                        data-testid="input-member-landline"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Job Title</Label>
                      <Input
                        value={formData.job_title}
                        onChange={(e) => setFormData(prev => ({ ...prev, job_title: e.target.value }))}
                        data-testid="input-member-job-title"
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3 py-2">
                      <User className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">First Name</p>
                        <p className="text-sm font-medium">{member.first_name || '-'}</p>
                      </div>
                    </div>
                    <Separator />
                    <div className="flex items-center gap-3 py-2">
                      <User className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Last Name</p>
                        <p className="text-sm font-medium">{member.last_name || '-'}</p>
                      </div>
                    </div>
                    <Separator />
                    <div className="flex items-center gap-3 py-2">
                      <Mail className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Email</p>
                        <p className="text-sm">{member.email || '-'}</p>
                      </div>
                    </div>
                    <Separator />
                    <div className="flex items-center gap-3 py-2">
                      <Smartphone className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Mobile</p>
                        <p className="text-sm">{member.mobile || '-'}</p>
                      </div>
                    </div>
                    <Separator />
                    <div className="flex items-center gap-3 py-2">
                      <PhoneCall className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Landline</p>
                        <p className="text-sm">{member.landline || '-'}</p>
                      </div>
                    </div>
                    <Separator />
                    <div className="flex items-center gap-3 py-2">
                      <Briefcase className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Job Title</p>
                        <p className="text-sm">{member.job_title || '-'}</p>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {/* Right column */}
            <div className="space-y-6">
              {/* Organisation Card */}
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-blue-600" />
                    Organisation
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-3">
                  {isEditing ? (
                    <div className="space-y-2">
                      <Label>Organisation</Label>
                      <Select 
                        value={formData.organization_id || '__none__'} 
                        onValueChange={(v) => setFormData(prev => ({ ...prev, organization_id: v === '__none__' ? '' : v }))}
                      >
                        <SelectTrigger data-testid="select-member-org">
                          <SelectValue placeholder="Select organisation" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">No Organisation</SelectItem>
                          {organizations.filter(o => o.id).map(o => (
                            <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : org ? (
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                        <Building2 className="w-4 h-4 text-blue-600" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900 text-sm">{org.name}</p>
                        {org.website_url && (
                          <a 
                            href={org.website_url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline flex items-center gap-1"
                          >
                            <Globe className="w-3 h-3" />
                            {org.website_url}
                          </a>
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No organisation assigned</p>
                  )}
                </CardContent>
              </Card>

              {/* Membership Card */}
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="w-4 h-4 text-purple-600" />
                    Membership
                  </CardTitle>
                </CardHeader>
                <CardContent className="py-3 space-y-3">
                  <div className="flex items-center gap-3">
                    <CalendarDays className="w-4 h-4 text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Member Since</p>
                      <p className="text-sm font-medium">
                        {member.created_on ? formatDate(member.created_on) : '-'}
                      </p>
                    </div>
                  </div>
                  <Separator />
                  <div className="flex items-center gap-3">
                    <Shield className="w-4 h-4 text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Role</p>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {member.role_id ? (
                          <Badge variant="secondary" className="text-xs">
                            {getRoleName(member.role_id)}
                          </Badge>
                        ) : (
                          <span className="text-sm text-slate-500">No role assigned</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <LogIn className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Login Enabled</p>
                        <p className="text-sm font-medium">
                          {isEditing ? (formData.login_enabled ? 'Yes' : 'No') : (member.login_enabled !== false ? 'Yes' : 'No')}
                        </p>
                      </div>
                    </div>
                    {isEditing && (
                      <Switch
                        checked={formData.login_enabled}
                        onCheckedChange={(checked) => setFormData(prev => ({ ...prev, login_enabled: checked }))}
                        data-testid="switch-login-enabled"
                      />
                    )}
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <Users className="w-4 h-4 text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Show in Directory</p>
                        <p className="text-sm font-medium">
                          {isEditing ? (formData.show_in_directory ? 'Yes' : 'No') : (member.show_in_directory !== false ? 'Yes' : 'No')}
                        </p>
                      </div>
                    </div>
                    {isEditing && (
                      <Switch
                        checked={formData.show_in_directory}
                        onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_in_directory: checked }))}
                        data-testid="switch-show-in-directory"
                      />
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Biography Card */}
          {(isEditing || member?.biography) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Biography</CardTitle>
              </CardHeader>
              <CardContent>
                {isEditing ? (
                  <Textarea
                    value={formData.biography}
                    onChange={(e) => setFormData(prev => ({ ...prev, biography: e.target.value }))}
                    rows={4}
                    data-testid="textarea-member-biography"
                  />
                ) : (
                  <p className="text-sm text-slate-600 whitespace-pre-wrap">{member.biography}</p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Roles Tab */}
        <TabsContent value="roles" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="w-5 h-5 text-blue-600" />
                Assigned Roles
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isEditing ? (
                <div className="space-y-3">
                  {roles.map(role => (
                    <div 
                      key={role.id} 
                      className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg cursor-pointer"
                      onClick={() => setSelectedRoleId(role.id)}
                    >
                      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                        selectedRoleId === role.id ? 'border-blue-600 bg-blue-600' : 'border-slate-300'
                      }`}>
                        {selectedRoleId === role.id && (
                          <div className="w-2 h-2 bg-white rounded-full" />
                        )}
                      </div>
                      <Label className="flex-1 cursor-pointer">
                        <p className="font-medium text-sm">{role.name}</p>
                        {role.description && (
                          <p className="text-xs text-slate-500">{role.description}</p>
                        )}
                      </Label>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {!member.role_id ? (
                    <p className="text-sm text-slate-500">No role assigned</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="secondary" className="text-sm">
                        {getRoleName(member.role_id)}
                      </Badge>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Tab */}
        <TabsContent value="activity" className="space-y-6">
          {member.created_on && (
            <Card>
              <CardContent className="py-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-purple-100 flex items-center justify-center">
                    <CalendarDays className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500">Member Since</p>
                    <p className="font-medium text-sm" data-testid="text-member-created-date">
                      {formatDate(member.created_on)}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <ClipboardList className="w-5 h-5 text-blue-600" />
                Recent Bookings
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bookingsLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
                </div>
              ) : memberBookings.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No bookings found</p>
              ) : (
                <div className="space-y-3">
                  {memberBookings.map(booking => {
                    const event = events.find(e => e.id === booking.event_id);
                    return (
                      <div key={booking.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                            <Calendar className="w-5 h-5 text-blue-600" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">{event?.title || 'Unknown Event'}</p>
                            <p className="text-xs text-slate-500">
                              {formatDate(booking.created_date)}
                            </p>
                          </div>
                        </div>
                        <Badge variant="outline">{booking.status || 'confirmed'}</Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
          {member.id && (
            <MemberEmails 
              memberId={member.id}
              memberEmail={member.email}
              memberName={`${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email}
            />
          )}
        </TabsContent>

        {/* Categories Tab */}
        <TabsContent value="categories" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-4">
              <CardTitle className="text-lg flex items-center gap-2">
                <FolderTree className="w-5 h-5 text-blue-600" />
                Category Preferences
              </CardTitle>
              {member?.id && (
                <Button 
                  size="sm" 
                  onClick={handleSaveCategories} 
                  disabled={isSavingCategories || categoriesLoading || selectionsLoading}
                  data-testid="button-save-categories"
                >
                  {isSavingCategories ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : (
                    <Save className="w-4 h-4 mr-1" />
                  )}
                  Save Categories
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {(categoriesLoading || selectionsLoading) ? (
                <div className="space-y-3">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="border border-slate-200 rounded-lg p-3 animate-pulse">
                      <div className="flex items-center gap-2">
                        <div className="w-4 h-4 bg-slate-200 rounded" />
                        <div className="h-4 bg-slate-200 rounded w-32" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : resourceCategories.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No categories available</p>
              ) : (() => {
                const categoriesWithSubcats = resourceCategories.filter(c => 
                  c.subcategories && Array.isArray(c.subcategories) && c.subcategories.length > 0
                );
                const flatCategories = resourceCategories.filter(c => 
                  !c.subcategories || !Array.isArray(c.subcategories) || c.subcategories.length === 0
                );
                
                return (
                  <div className="space-y-6">
                    <p className="text-sm text-slate-600">
                      Select the categories that interest this member. These preferences help personalize content recommendations.
                    </p>
                    
                    {flatCategories.length > 0 && (
                      <div className="space-y-3">
                        <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                          <FolderTree className="w-4 h-4 text-slate-500" />
                          Categories
                        </h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {flatCategories.map(category => {
                            const isSelected = isSubcategorySelected(category.id, null);
                            return (
                              <div 
                                key={category.id} 
                                className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                                  isSelected 
                                    ? 'border-blue-500 bg-blue-50' 
                                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                }`}
                                onClick={() => toggleSubcategory(category.id, null)}
                                data-testid={`category-card-${category.id}`}
                              >
                                <div className="flex items-start gap-3">
                                  <Checkbox
                                    id={`cat-${category.id}`}
                                    checked={isSelected}
                                    onCheckedChange={() => toggleSubcategory(category.id, null)}
                                    data-testid={`checkbox-category-${category.id}`}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <Label 
                                      htmlFor={`cat-${category.id}`} 
                                      className="font-medium text-sm cursor-pointer text-slate-900"
                                    >
                                      {category.name}
                                    </Label>
                                    {category.description && (
                                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                                        {category.description}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    
                    {categoriesWithSubcats.map(category => {
                      const selectedCount = (category.subcategories || []).filter(subName => 
                        isSubcategorySelected(category.id, subName)
                      ).length;
                      
                      return (
                        <div key={category.id} className="space-y-3">
                          <div className="flex items-center justify-between">
                            <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                              <FolderTree className="w-4 h-4 text-slate-500" />
                              {category.name}
                            </h3>
                            {selectedCount > 0 && (
                              <Badge variant="secondary" className="text-xs">
                                {selectedCount} selected
                              </Badge>
                            )}
                          </div>
                          {category.description && (
                            <p className="text-xs text-slate-500 -mt-1">{category.description}</p>
                          )}
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                            {(category.subcategories || []).map((subcatName, idx) => {
                              const isSelected = isSubcategorySelected(category.id, subcatName);
                              const uniqueKey = `${category.id}-${subcatName}`;
                              return (
                                <div 
                                  key={uniqueKey} 
                                  className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                                    isSelected 
                                      ? 'border-blue-500 bg-blue-50' 
                                      : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                                  }`}
                                  onClick={() => toggleSubcategory(category.id, subcatName)}
                                  data-testid={`subcategory-card-${category.id}-${idx}`}
                                >
                                  <div className="flex items-start gap-3">
                                    <Checkbox
                                      id={`subcat-${uniqueKey}`}
                                      checked={isSelected}
                                      onCheckedChange={() => toggleSubcategory(category.id, subcatName)}
                                      data-testid={`checkbox-subcategory-${category.id}-${idx}`}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <Label 
                                        htmlFor={`subcat-${uniqueKey}`} 
                                        className="font-medium text-sm cursor-pointer text-slate-900"
                                      >
                                        {subcatName}
                                      </Label>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                    
                    {selectedSubcategories.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-slate-200">
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">{selectedSubcategories.length}</span> {selectedSubcategories.length === 1 ? 'item' : 'items'} selected
                        </p>
                      </div>
                    )}
                  </div>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Balances Tab */}
        <TabsContent value="balances" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Trophy className="w-5 h-5 text-amber-600" />
                Engagement Opening Balances
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-slate-600 mb-6">
                Set opening balances for engagement metrics. These values will be added to the calculated totals in the Team Engagement Report.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="balance-events">Events Attended</Label>
                  <Input
                    id="balance-events"
                    type="number"
                    min="0"
                    value={openingBalances.eventsAttended}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      eventsAttended: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-events"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-articles">Articles Published</Label>
                  <Input
                    id="balance-articles"
                    type="number"
                    min="0"
                    value={openingBalances.articlesPublished}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      articlesPublished: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-articles"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-jobs">Jobs Posted</Label>
                  <Input
                    id="balance-jobs"
                    type="number"
                    min="0"
                    value={openingBalances.jobsPosted}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      jobsPosted: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-jobs"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-awards">Awards (Online + Offline)</Label>
                  <Input
                    id="balance-awards"
                    type="number"
                    min="0"
                    value={openingBalances.awards}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      awards: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-awards"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label htmlFor="balance-engagement">Engagement Awards</Label>
                  <Input
                    id="balance-engagement"
                    type="number"
                    min="0"
                    value={openingBalances.engagementAwards}
                    onChange={(e) => setOpeningBalances(prev => ({ 
                      ...prev, 
                      engagementAwards: parseInt(e.target.value) || 0 
                    }))}
                    data-testid="input-balance-engagement"
                  />
                </div>
              </div>
              
              <div className="mt-6 pt-4 border-t border-slate-200">
                <Button 
                  onClick={handleSaveOpeningBalances}
                  disabled={isSavingBalances}
                  data-testid="button-save-balances"
                >
                  {isSavingBalances ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-1" />
                  )}
                  Save Opening Balances
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notes Tab */}
        <TabsContent value="notes" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <StickyNote className="w-5 h-5 text-blue-600" />
                Member Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Textarea
                  placeholder="Add a note..."
                  value={newNoteContent}
                  onChange={(e) => setNewNoteContent(e.target.value)}
                  className="min-h-[100px]"
                  data-testid="input-new-member-note"
                />
                <div className="flex justify-end">
                  <Button
                    onClick={() => createNoteMutation.mutate({ content: newNoteContent })}
                    disabled={!newNoteContent.trim() || createNoteMutation.isPending}
                    data-testid="button-add-member-note"
                  >
                    {createNoteMutation.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 mr-2" />
                    )}
                    Add Note
                  </Button>
                </div>
              </div>

              <Separator />

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search notes by content or creator..."
                  value={noteSearchTerm}
                  onChange={(e) => {
                    setNoteSearchTerm(e.target.value);
                    setNotesPage(1);
                  }}
                  className="pl-10"
                  data-testid="input-search-member-notes"
                />
              </div>

              {(() => {
                const searchLower = noteSearchTerm.toLowerCase();
                const filteredNotes = memberNotes.filter(note => 
                  note.content?.toLowerCase().includes(searchLower) ||
                  note.author_name?.toLowerCase().includes(searchLower)
                );
                const totalPages = Math.max(1, Math.ceil(filteredNotes.length / notesPerPage));
                const clampedPage = Math.min(notesPage, totalPages);
                if (clampedPage !== notesPage && filteredNotes.length > 0) {
                  setTimeout(() => setNotesPage(clampedPage), 0);
                }
                const paginatedNotes = filteredNotes.slice(
                  (clampedPage - 1) * notesPerPage,
                  clampedPage * notesPerPage
                );

                if (notesLoading) {
                  return (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                    </div>
                  );
                }

                if (memberNotes.length === 0) {
                  return (
                    <div className="text-center py-12 text-slate-500">
                      <MessageSquare className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                      <p>No notes yet</p>
                      <p className="text-sm text-slate-400 mt-1">Add a note above to get started</p>
                    </div>
                  );
                }

                if (filteredNotes.length === 0) {
                  return (
                    <div className="text-center py-12 text-slate-500">
                      <Search className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                      <p>No notes match your search</p>
                      <p className="text-sm text-slate-400 mt-1">Try a different search term</p>
                    </div>
                  );
                }

                return (
                  <>
                    <div className="space-y-4">
                      {paginatedNotes.map(note => (
                        <div key={note.id} className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-3" data-testid={`member-note-${note.id}`}>
                          {editingNoteId === note.id ? (
                            <div className="space-y-3">
                              <Textarea
                                value={editingNoteContent}
                                onChange={(e) => setEditingNoteContent(e.target.value)}
                                className="min-h-[80px]"
                                data-testid={`input-edit-member-note-${note.id}`}
                              />
                              <div className="flex gap-2 justify-end">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setEditingNoteId(null);
                                    setEditingNoteContent('');
                                  }}
                                  data-testid={`button-cancel-edit-member-note-${note.id}`}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => updateNoteMutation.mutate({ noteId: note.id, content: editingNoteContent })}
                                  disabled={!editingNoteContent.trim() || updateNoteMutation.isPending}
                                  data-testid={`button-save-member-note-${note.id}`}
                                >
                                  {updateNoteMutation.isPending ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    'Save'
                                  )}
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p className="text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{note.content}</p>
                              <div className="flex items-center justify-between text-sm">
                                <div className="flex items-center gap-2 text-slate-500">
                                  <User className="w-3 h-3" />
                                  <span>{note.author_name}</span>
                                  <span className="text-slate-300">|</span>
                                  <span>{note.created_at ? format(new Date(note.created_at), 'dd MMM yyyy, HH:mm') : ''}</span>
                                  {note.updated_at && note.updated_at !== note.created_at && (
                                    <span className="italic text-slate-400">(edited)</span>
                                  )}
                                </div>
                                <div className="flex gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => {
                                      setEditingNoteId(note.id);
                                      setEditingNoteContent(note.content);
                                    }}
                                    data-testid={`button-edit-member-note-${note.id}`}
                                  >
                                    <Pencil className="w-4 h-4 text-slate-400 hover:text-blue-600" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setNoteToDelete(note.id)}
                                    disabled={deleteNoteMutation.isPending}
                                    data-testid={`button-delete-member-note-${note.id}`}
                                  >
                                    <Trash2 className="w-4 h-4 text-slate-400 hover:text-red-600" />
                                  </Button>
                                </div>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>

                    {totalPages > 1 && (
                      <div className="flex items-center justify-between pt-4">
                        <p className="text-sm text-slate-500">
                          Showing {(clampedPage - 1) * notesPerPage + 1} - {Math.min(clampedPage * notesPerPage, filteredNotes.length)} of {filteredNotes.length} notes
                        </p>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setNotesPage(p => Math.max(1, p - 1))}
                            disabled={clampedPage === 1}
                            data-testid="button-member-notes-prev-page"
                          >
                            <ChevronLeft className="w-4 h-4" />
                          </Button>
                          <span className="text-sm text-slate-600">
                            Page {clampedPage} of {totalPages}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setNotesPage(p => Math.min(totalPages, p + 1))}
                            disabled={clampedPage === totalPages}
                            data-testid="button-member-notes-next-page"
                          >
                            <ChevronRight className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Communications Tab */}
        <TabsContent value="communications" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-blue-600" />
                Communication Preferences
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {communicationCategoriesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : availableCommCategories.length === 0 ? (
                <div className="text-center py-8 text-slate-500">
                  <Mail className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No communication categories available for this member's role.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {availableCommCategories.map((category) => {
                    const pref = communicationPreferences.find(p => p.category_id === category.id);
                    const isSubscribed = pref ? pref.is_subscribed : true;
                    
                    return (
                      <div 
                        key={category.id} 
                        className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border border-slate-200"
                        data-testid={`comm-category-${category.id}`}
                      >
                        <div className="space-y-1">
                          <h4 className="font-medium text-slate-900">{category.name}</h4>
                          {category.description && (
                            <p className="text-sm text-slate-500">{category.description}</p>
                          )}
                        </div>
                        <Switch
                          checked={isSubscribed}
                          onCheckedChange={(checked) => handleCommunicationToggle(category.id, checked)}
                          disabled={updatingCommPrefs.has(category.id)}
                          data-testid={`switch-comm-${category.id}`}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Delete Note Confirmation Dialog */}
      <AlertDialog open={!!noteToDelete} onOpenChange={() => setNoteToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Note</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this note? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteNoteMutation.mutate(noteToDelete)}
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
