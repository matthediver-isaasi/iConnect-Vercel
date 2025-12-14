import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  User, 
  ArrowLeft, 
  Building2, 
  Mail, 
  Smartphone,
  PhoneCall, 
  Briefcase,
  Pencil, 
  Save, 
  X, 
  Loader2,
  ExternalLink,
  Calendar,
  CalendarDays,
  Shield,
  ClipboardList,
  Linkedin,
  Globe,
  LogIn,
  FolderTree
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useDateFormat } from "@/hooks/useDateFormat";

export default function MemberDetailView({ 
  member, 
  onBack, 
  memberCustomFields = [],
  organizations = [],
  roles = [],
  isNew = false,
  onCreated,
  defaultOrganizationId = ''
}) {
  const { isAdmin } = useMemberAccess();
  const { formatDate } = useDateFormat();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(isNew);
  const [activeTab, setActiveTab] = useState('overview');
  const [formData, setFormData] = useState({
    first_name: '',
    last_name: '',
    email: '',
    mobile: '',
    landline: '',
    job_title: '',
    bio: '',
    organization_id: defaultOrganizationId,
    disabled: false,
    login_enabled: true
  });

  const getMemberName = (m) => {
    return [m?.first_name, m?.last_name].filter(Boolean).join(' ') || '';
  };
  const [customFieldValues, setCustomFieldValues] = useState({});
  const [selectedRoles, setSelectedRoles] = useState([]);
  const [selectedSubcategories, setSelectedSubcategories] = useState([]);
  const [isSavingCategories, setIsSavingCategories] = useState(false);

  const { data: memberValues = [], isLoading: valuesLoading } = useQuery({
    queryKey: ['member-detail-preference-values', member?.id],
    enabled: !!member?.id,
    queryFn: async () => {
      try {
        const values = await base44.entities.MemberPreferenceValue.list({
          filter: { member_id: member.id }
        });
        return values || [];
      } catch {
        return [];
      }
    }
  });

  const { data: memberBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['member-detail-bookings', member?.id],
    enabled: !!member?.id && activeTab === 'activity',
    queryFn: async () => {
      try {
        const bookings = await base44.entities.Booking.list({
          filter: { member_id: member.id }
        });
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
    queryFn: async () => {
      return await base44.entities.Event.list();
    }
  });

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

  const { data: preferenceFields = [], isLoading: prefFieldsLoading } = useQuery({
    queryKey: ['category-preference-fields'],
    enabled: activeTab === 'categories',
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true }
        });
        return fields || [];
      } catch {
        return [];
      }
    }
  });

  useEffect(() => {
    // Only populate form from member data when editing an existing member (has id)
    // Skip this for new member creation to preserve defaultOrganizationId
    if (member?.id) {
      setFormData({
        first_name: member.first_name || '',
        last_name: member.last_name || '',
        email: member.email || '',
        mobile: member.mobile || '',
        landline: member.landline || '',
        job_title: member.job_title || '',
        bio: member.bio || '',
        organization_id: member.organization_id || '',
        disabled: member.disabled || false,
        login_enabled: member.login_enabled !== false
      });
      setSelectedRoles(member.roles || (member.role_id ? [member.role_id] : []));
    }
  }, [member]);

  useEffect(() => {
    if (memberValues.length > 0) {
      const valuesMap = {};
      memberValues.forEach(pv => {
        valuesMap[pv.field_id] = pv.value;
      });
      setCustomFieldValues(valuesMap);
    }
  }, [memberValues]);

  // Load selected subcategories from memberValues when data is ready
  // This effect runs whenever memberValues or resourceCategories change
  useEffect(() => {
    if (resourceCategories.length === 0) return;
    
    // Build set of all valid subcategory names
    const allSubcategoryNames = new Set();
    resourceCategories.forEach(cat => {
      if (cat.subcategories && Array.isArray(cat.subcategories)) {
        cat.subcategories.forEach(sub => {
          const subName = typeof sub === 'string' ? sub : (sub.name || sub.id);
          allSubcategoryNames.add(subName);
        });
      }
    });

    // Find subcategories stored in memberValues
    const storedSubcats = [];
    memberValues.forEach(pv => {
      try {
        const parsed = JSON.parse(pv.value);
        if (Array.isArray(parsed)) {
          parsed.forEach(val => {
            if (allSubcategoryNames.has(val)) {
              storedSubcats.push(val);
            }
          });
        }
      } catch {}
    });
    
    // Always set state to reflect current server state
    setSelectedSubcategories(storedSubcats);
  }, [memberValues, resourceCategories]);

  const createMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.Member.create(data);
    },
    onSuccess: (createdMember) => {
      toast.success("Member created successfully");
      queryClient.invalidateQueries({ queryKey: ['members-crm-list'] });
      if (onCreated) {
        onCreated(createdMember);
      }
    },
    onError: (error) => {
      toast.error("Failed to create member: " + (error.message || "Unknown error"));
    }
  });

  const updateMutation = useMutation({
    mutationFn: async (data) => {
      return await base44.entities.Member.update(member.id, data);
    },
    onSuccess: () => {
      toast.success("Member updated successfully");
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ['members-crm-list'] });
      queryClient.invalidateQueries({ queryKey: ['member-detail-preference-values', member.id] });
    },
    onError: (error) => {
      toast.error("Failed to update member: " + (error.message || "Unknown error"));
    }
  });

  const handleSave = async () => {
    if (isNew) {
      if (createMutation.isPending) return;
      
      if (!formData.email?.trim()) {
        toast.error('Email is required');
        return;
      }
      
      createMutation.mutate({
        ...formData,
        roles: selectedRoles
      }, {
        onSuccess: async (createdMember) => {
          const currentCustomFieldValues = { ...customFieldValues };
          for (const [fieldId, value] of Object.entries(currentCustomFieldValues)) {
            const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value ?? '');
            if (storedValue && storedValue !== '[]') {
              try {
                await base44.entities.MemberPreferenceValue.create({
                  member_id: createdMember.id,
                  field_id: fieldId,
                  value: storedValue
                });
              } catch (err) {
                console.error('Failed to save custom field:', fieldId, err);
              }
            }
          }
          queryClient.invalidateQueries({ queryKey: ['all-member-preference-values-crm'] });
        }
      });
    } else {
      updateMutation.mutate({
        ...formData,
        roles: selectedRoles
      });
    }
  };

  const handleCancel = () => {
    if (isNew) {
      onBack?.();
      return;
    }
    
    setFormData({
      first_name: member.first_name || '',
      last_name: member.last_name || '',
      email: member.email || '',
      mobile: member.mobile || '',
      landline: member.landline || '',
      job_title: member.job_title || '',
      bio: member.bio || '',
      organization_id: member.organization_id || '',
      disabled: member.disabled || false,
      login_enabled: member.login_enabled !== false
    });
    setSelectedRoles(member.roles || (member.role_id ? [member.role_id] : []));
    setIsEditing(false);
  };

  const toggleRole = (roleId) => {
    setSelectedRoles(prev => 
      prev.includes(roleId) 
        ? prev.filter(r => r !== roleId)
        : [...prev, roleId]
    );
  };

  const toggleSubcategory = (subcategory) => {
    setSelectedSubcategories(prev => 
      prev.includes(subcategory)
        ? prev.filter(s => s !== subcategory)
        : [...prev, subcategory]
    );
  };

  const handleSaveCategories = async () => {
    if (!member?.id) return;
    
    // Guard against saving while data is still loading
    if (prefFieldsLoading || categoriesLoading) {
      toast.error("Please wait for data to load");
      return;
    }
    
    setIsSavingCategories(true);
    try {
      const storedValue = JSON.stringify(selectedSubcategories);
      
      // Build a set of all valid subcategory names from resourceCategories
      const allSubcategoryNames = new Set();
      resourceCategories.forEach(cat => {
        if (cat.subcategories && Array.isArray(cat.subcategories)) {
          cat.subcategories.forEach(sub => {
            const subName = typeof sub === 'string' ? sub : (sub.name || sub.id);
            allSubcategoryNames.add(subName);
          });
        }
      });
      
      // Find a valid PreferenceField for categories
      const categoryField = preferenceFields.find(f => 
        f.label?.toLowerCase().includes('category') || 
        f.label?.toLowerCase().includes('interest') ||
        f.field_type === 'resource_categories'
      );
      
      // Find existing memberValue that contains category data
      let existingCategoryValue = null;
      
      // First try to find by matching field_id to categoryField
      if (categoryField) {
        existingCategoryValue = memberValues.find(pv => pv.field_id === categoryField.id);
      }
      
      // If not found by field_id, try to find by examining array values
      if (!existingCategoryValue) {
        for (const pv of memberValues) {
          try {
            const parsed = JSON.parse(pv.value);
            if (Array.isArray(parsed) && parsed.some(val => allSubcategoryNames.has(val))) {
              existingCategoryValue = pv;
              break;
            }
          } catch {}
        }
      }
      
      if (existingCategoryValue) {
        // Update existing record (even if empty array to clear selections)
        await base44.entities.MemberPreferenceValue.update(existingCategoryValue.id, {
          value: storedValue
        });
      } else if (selectedSubcategories.length > 0) {
        // For new records, require a valid PreferenceField to maintain data model integrity
        if (!categoryField) {
          toast.error("No category preference field is configured. Please contact an administrator to set up a preference field for categories.");
          return;
        }
        
        await base44.entities.MemberPreferenceValue.create({
          member_id: member.id,
          field_id: categoryField.id,
          value: storedValue
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['member-detail-preference-values', member.id] });
      toast.success("Category preferences saved");
    } catch (error) {
      toast.error("Failed to save category preferences");
      console.error(error);
    } finally {
      setIsSavingCategories(false);
    }
  };

  const getInitials = (name) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  };

  const getOrganization = () => {
    return organizations.find(o => o.id === member?.organization_id);
  };

  const getRoleNames = (roleIds) => {
    return roleIds.map(id => roles.find(r => r.id === id)?.name || id);
  };

  if (!member && !isNew) return null;

  const org = getOrganization();

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-to-members">
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <div className="flex items-center gap-3">
              <Avatar className="h-12 w-12">
                {isNew ? (
                  <AvatarFallback className="bg-green-100 text-green-700">
                    <User className="w-6 h-6" />
                  </AvatarFallback>
                ) : (
                  <>
                    <AvatarImage src={member?.profile_photo} />
                    <AvatarFallback className="bg-blue-100 text-blue-700">
                      {getInitials(getMemberName(member))}
                    </AvatarFallback>
                  </>
                )}
              </Avatar>
              <div>
                <h1 className="text-xl font-semibold text-slate-900">
                  {isNew ? 'Add New Member' : (getMemberName(member) || 'Unknown Member')}
                </h1>
                {!isNew && (
                  <p className="text-sm text-slate-500 flex items-center gap-2">
                    {member?.job_title && <span>{member.job_title}</span>}
                    {member?.job_title && org && <span>•</span>}
                    {org && <span>{org.name}</span>}
                  </p>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isNew && (member?.disabled ? (
              <Badge variant="secondary" className="bg-red-100 text-red-700">Disabled</Badge>
            ) : (
              <Badge variant="secondary" className="bg-green-100 text-green-700">Active</Badge>
            ))}
            {isAdmin && !isEditing && !isNew && (
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-member">
                <Pencil className="w-4 h-4 mr-1" />
                Edit
              </Button>
            )}
            {(isEditing || isNew) && (
              <>
                <Button variant="ghost" size="sm" onClick={handleCancel} data-testid="button-cancel-edit-member">
                  <X className="w-4 h-4 mr-1" />
                  Cancel
                </Button>
                <Button 
                  size="sm" 
                  onClick={handleSave} 
                  disabled={isNew ? createMutation.isPending : updateMutation.isPending} 
                  data-testid="button-save-member"
                >
                  {(isNew ? createMutation.isPending : updateMutation.isPending) ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-1" />
                  )}
                  {isNew ? 'Create Member' : 'Save'}
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
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
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="disabled"
                          checked={formData.disabled}
                          onCheckedChange={(checked) => setFormData(prev => ({ ...prev, disabled: checked }))}
                          data-testid="checkbox-member-disabled"
                        />
                        <Label htmlFor="disabled" className="text-sm">Account Disabled</Label>
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

              <div className="space-y-6">
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
                            {organizations.filter(org => org.id).map(org => (
                              <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
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

                <Card>
                  <CardHeader className="py-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Shield className="w-4 h-4 text-purple-600" />
                      Membership
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="py-3 space-y-3">
                    {!isNew && (
                      <>
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
                              {(() => {
                                const memberRoles = member.roles || (member.role_id ? [member.role_id] : []);
                                if (memberRoles.length === 0) {
                                  return <span className="text-sm text-slate-500">No role assigned</span>;
                                }
                                return getRoleNames(memberRoles).map((roleName, idx) => (
                                  <Badge key={idx} variant="secondary" className="text-xs">
                                    {roleName}
                                  </Badge>
                                ));
                              })()}
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
                      </>
                    )}
                    {isNew && (
                      <p className="text-sm text-slate-500">Membership details will be shown after creation</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </div>

            {(isEditing || member?.bio) && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Bio</CardTitle>
                </CardHeader>
                <CardContent>
                  {isEditing ? (
                    <Textarea
                      value={formData.bio}
                      onChange={(e) => setFormData(prev => ({ ...prev, bio: e.target.value }))}
                      rows={4}
                      data-testid="textarea-member-bio"
                    />
                  ) : (
                    <p className="text-sm text-slate-600 whitespace-pre-wrap">{member.bio}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {memberCustomFields.filter(f => !f.field_type?.startsWith('category')).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Custom Fields</CardTitle>
                </CardHeader>
                <CardContent>
                  {valuesLoading && !isNew ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                    </div>
                  ) : isEditing ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {memberCustomFields.filter(f => !f.field_type?.startsWith('category')).map(field => {
                        const value = customFieldValues[field.id] ?? '';
                        
                        const handleCustomFieldChange = (fieldId, newValue) => {
                          setCustomFieldValues(prev => ({
                            ...prev,
                            [fieldId]: newValue
                          }));
                        };
                        
                        if (field.field_type === 'dropdown' || field.field_type === 'picklist') {
                          const options = field.options || [];
                          return (
                            <div key={field.id} className="space-y-2">
                              <Label>{field.label}</Label>
                              <Select
                                value={value || '__none__'}
                                onValueChange={(v) => handleCustomFieldChange(field.id, v === '__none__' ? '' : v)}
                              >
                                <SelectTrigger data-testid={`select-custom-field-${field.id}`}>
                                  <SelectValue placeholder={`Select ${field.label}`} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__">None</SelectItem>
                                  {options.filter(opt => opt).map((opt, idx) => {
                                    const optValue = typeof opt === 'object' ? opt.value : opt;
                                    const optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                                    return (
                                      <SelectItem key={optValue || idx} value={optValue}>{optLabel}</SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        } else if (field.field_type === 'boolean' || field.field_type === 'checkbox') {
                          return (
                            <div key={field.id} className="flex items-center gap-2 pt-6">
                              <Checkbox
                                id={`custom-field-${field.id}`}
                                checked={value === 'true' || value === true}
                                onCheckedChange={(checked) => handleCustomFieldChange(field.id, checked ? 'true' : 'false')}
                                data-testid={`checkbox-custom-field-${field.id}`}
                              />
                              <Label htmlFor={`custom-field-${field.id}`}>{field.label}</Label>
                            </div>
                          );
                        } else if (field.field_type === 'textarea' || field.field_type === 'long_text') {
                          return (
                            <div key={field.id} className="space-y-2 md:col-span-2">
                              <Label>{field.label}</Label>
                              <Textarea
                                value={value}
                                onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
                                rows={3}
                                data-testid={`textarea-custom-field-${field.id}`}
                              />
                            </div>
                          );
                        } else if (field.field_type === 'date') {
                          return (
                            <div key={field.id} className="space-y-2">
                              <Label>{field.label}</Label>
                              <Input
                                type="date"
                                value={value}
                                onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
                                data-testid={`input-custom-field-${field.id}`}
                              />
                            </div>
                          );
                        } else if (field.field_type === 'number') {
                          return (
                            <div key={field.id} className="space-y-2">
                              <Label>{field.label}</Label>
                              <Input
                                type="number"
                                value={value}
                                onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
                                data-testid={`input-custom-field-${field.id}`}
                              />
                            </div>
                          );
                        } else {
                          return (
                            <div key={field.id} className="space-y-2">
                              <Label>{field.label}</Label>
                              <Input
                                type={field.field_type === 'email' ? 'email' : field.field_type === 'url' ? 'url' : 'text'}
                                value={value}
                                onChange={(e) => handleCustomFieldChange(field.id, e.target.value)}
                                placeholder={field.placeholder || ''}
                                data-testid={`input-custom-field-${field.id}`}
                              />
                            </div>
                          );
                        }
                      })}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {memberCustomFields.filter(f => !f.field_type?.startsWith('category')).map(field => {
                        const value = customFieldValues[field.id];
                        let displayValue;
                        
                        if (field.field_type === 'date') {
                          displayValue = formatDate(value);
                        } else if (field.field_type === 'email' && value) {
                          displayValue = <a href={`mailto:${value}`} className="text-blue-600 hover:underline">{value}</a>;
                        } else if (field.field_type === 'url' && value) {
                          displayValue = <a href={value} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">{value} <ExternalLink className="w-3 h-3" /></a>;
                        } else if (field.field_type === 'boolean' || field.field_type === 'checkbox') {
                          displayValue = value === 'true' || value === true ? 'Yes' : 'No';
                        } else if ((field.field_type === 'dropdown' || field.field_type === 'picklist') && value) {
                          // For dropdowns, find the label from options if value is stored
                          const options = field.options || [];
                          const matchedOpt = options.find(opt => 
                            (typeof opt === 'object' ? opt.value : opt) === value
                          );
                          displayValue = matchedOpt 
                            ? (typeof matchedOpt === 'object' ? matchedOpt.label || matchedOpt.value : matchedOpt)
                            : value;
                        } else {
                          displayValue = typeof value === 'object' ? JSON.stringify(value) : (value || '-');
                        }
                        
                        return (
                          <div key={field.id} className="space-y-1">
                            <p className="text-xs text-slate-500">{field.label}</p>
                            <p className="text-sm">{displayValue}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="activity" className="space-y-6">
            {!isNew && member.created_on && (
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
          </TabsContent>

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
                      <div key={role.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                        <Checkbox
                          id={`role-${role.id}`}
                          checked={selectedRoles.includes(role.id)}
                          onCheckedChange={() => toggleRole(role.id)}
                          data-testid={`checkbox-role-${role.id}`}
                        />
                        <Label htmlFor={`role-${role.id}`} className="flex-1 cursor-pointer">
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
                    {(member.roles || (member.role_id ? [member.role_id] : [])).length === 0 ? (
                      <p className="text-sm text-slate-500">No roles assigned</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {getRoleNames(member.roles || (member.role_id ? [member.role_id] : [])).map((roleName, idx) => (
                          <Badge key={idx} variant="secondary" className="text-sm">
                            {roleName}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="categories" className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <FolderTree className="w-5 h-5 text-blue-600" />
                  Category Preferences
                </CardTitle>
                {!isNew && member?.id && (
                  <Button 
                    size="sm" 
                    onClick={handleSaveCategories} 
                    disabled={isSavingCategories || categoriesLoading || prefFieldsLoading}
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
                {(categoriesLoading || prefFieldsLoading || valuesLoading) ? (
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
                ) : (
                  <Accordion type="multiple" className="space-y-2">
                    {resourceCategories.map(category => {
                      const hasSubcategories = category.subcategories && category.subcategories.length > 0;
                      if (!hasSubcategories) return null;
                      
                      // Normalize subcategories to string names
                      const normalizedSubcats = category.subcategories.map(sub => 
                        typeof sub === 'string' ? sub : (sub.name || sub.id || String(sub))
                      );
                      const sortedSubcats = [...normalizedSubcats].sort((a, b) => 
                        a.localeCompare(b, undefined, { sensitivity: 'base' })
                      );
                      const selectedCount = sortedSubcats.filter(sub => selectedSubcategories.includes(sub)).length;

                      return (
                        <AccordionItem 
                          key={category.id} 
                          value={category.id}
                          className="border border-slate-200 rounded-lg px-0"
                          data-testid={`accordion-category-${category.id}`}
                        >
                          <AccordionTrigger className="px-3 py-3 hover:no-underline hover:bg-slate-50 rounded-t-lg">
                            <div className="flex items-center gap-2">
                              <FolderTree className="w-4 h-4 text-blue-600" />
                              <span className="font-medium text-sm text-slate-900">{category.name}</span>
                              {selectedCount > 0 && (
                                <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">
                                  {selectedCount} selected
                                </Badge>
                              )}
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-3 pb-3 bg-slate-50 rounded-b-lg">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-2">
                              {sortedSubcats.map((subcatName, idx) => (
                                <div key={`${category.id}-${idx}`} className="flex items-center gap-2">
                                  <Checkbox
                                    id={`subcat-${category.id}-${idx}`}
                                    checked={selectedSubcategories.includes(subcatName)}
                                    onCheckedChange={() => toggleSubcategory(subcatName)}
                                    data-testid={`checkbox-subcat-${category.id}-${idx}`}
                                  />
                                  <Label 
                                    htmlFor={`subcat-${category.id}-${idx}`} 
                                    className="text-sm cursor-pointer text-slate-700"
                                  >
                                    {subcatName}
                                  </Label>
                                </div>
                              ))}
                            </div>
                          </AccordionContent>
                        </AccordionItem>
                      );
                    })}
                  </Accordion>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
