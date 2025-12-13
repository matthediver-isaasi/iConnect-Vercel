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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { 
  User, 
  ArrowLeft, 
  Building2, 
  Mail, 
  Phone, 
  Briefcase,
  Pencil, 
  Save, 
  X, 
  Loader2,
  ExternalLink,
  Calendar,
  Shield,
  ClipboardList,
  Linkedin,
  Globe
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
  onCreated
}) {
  const { isAdmin } = useMemberAccess();
  const { formatDate } = useDateFormat();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(isNew);
  const [activeTab, setActiveTab] = useState('overview');
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    phone: '',
    job_title: '',
    bio: '',
    linkedin_url: '',
    organization_id: '',
    disabled: false
  });
  const [customFieldValues, setCustomFieldValues] = useState({});
  const [selectedRoles, setSelectedRoles] = useState([]);

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

  useEffect(() => {
    if (member) {
      setFormData({
        full_name: member.full_name || '',
        email: member.email || '',
        phone: member.phone || '',
        job_title: member.job_title || '',
        bio: member.bio || '',
        linkedin_url: member.linkedin_url || '',
        organization_id: member.organization_id || '',
        disabled: member.disabled || false
      });
      setSelectedRoles(member.roles || []);
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
      full_name: member.full_name || '',
      email: member.email || '',
      phone: member.phone || '',
      job_title: member.job_title || '',
      bio: member.bio || '',
      linkedin_url: member.linkedin_url || '',
      organization_id: member.organization_id || '',
      disabled: member.disabled || false
    });
    setSelectedRoles(member.roles || []);
    setIsEditing(false);
  };

  const toggleRole = (roleId) => {
    setSelectedRoles(prev => 
      prev.includes(roleId) 
        ? prev.filter(r => r !== roleId)
        : [...prev, roleId]
    );
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
                      {getInitials(member?.full_name)}
                    </AvatarFallback>
                  </>
                )}
              </Avatar>
              <div>
                <h1 className="text-xl font-semibold text-slate-900">
                  {isNew ? 'Add New Member' : (member?.full_name || 'Unknown Member')}
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
                        <Label>Full Name</Label>
                        <Input
                          value={formData.full_name}
                          onChange={(e) => setFormData(prev => ({ ...prev, full_name: e.target.value }))}
                          data-testid="input-member-name"
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
                        <Label>Phone</Label>
                        <Input
                          value={formData.phone}
                          onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                          data-testid="input-member-phone"
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
                      <div className="space-y-2">
                        <Label>LinkedIn URL</Label>
                        <Input
                          value={formData.linkedin_url}
                          onChange={(e) => setFormData(prev => ({ ...prev, linkedin_url: e.target.value }))}
                          placeholder="https://linkedin.com/in/..."
                          data-testid="input-member-linkedin"
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
                          <p className="text-xs text-slate-500">Full Name</p>
                          <p className="text-sm font-medium">{member.full_name || '-'}</p>
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
                        <Phone className="w-4 h-4 text-slate-400" />
                        <div>
                          <p className="text-xs text-slate-500">Phone</p>
                          <p className="text-sm">{member.phone || '-'}</p>
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
                      {member.linkedin_url && (
                        <>
                          <Separator />
                          <div className="flex items-center gap-3 py-2">
                            <Linkedin className="w-4 h-4 text-slate-400" />
                            <div>
                              <p className="text-xs text-slate-500">LinkedIn</p>
                              <a 
                                href={member.linkedin_url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                              >
                                View Profile <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-blue-600" />
                    Organisation
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {isEditing ? (
                    <div className="space-y-2">
                      <Label>Organisation</Label>
                      <Select 
                        value={formData.organization_id} 
                        onValueChange={(v) => setFormData(prev => ({ ...prev, organization_id: v }))}
                      >
                        <SelectTrigger data-testid="select-member-org">
                          <SelectValue placeholder="Select organisation" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">No Organisation</SelectItem>
                          {organizations.map(org => (
                            <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : org ? (
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                        <Building2 className="w-5 h-5 text-blue-600" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">{org.name}</p>
                        {org.website_url && (
                          <a 
                            href={org.website_url} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-sm text-blue-600 hover:underline flex items-center gap-1"
                          >
                            <Globe className="w-3 h-3" />
                            {org.website_url}
                          </a>
                        )}
                        <Badge variant="secondary" className="mt-2">
                          {org.status || 'active'}
                        </Badge>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No organisation assigned</p>
                  )}
                </CardContent>
              </Card>
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

            {memberCustomFields.length > 0 && (
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
                      {memberCustomFields.map(field => {
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
                                value={value}
                                onValueChange={(v) => handleCustomFieldChange(field.id, v)}
                              >
                                <SelectTrigger data-testid={`select-custom-field-${field.id}`}>
                                  <SelectValue placeholder={`Select ${field.label}`} />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="">None</SelectItem>
                                  {options.map(opt => (
                                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                                  ))}
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
                      {memberCustomFields.map(field => {
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
                        } else {
                          displayValue = value || '-';
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
                    {(member.roles || []).length === 0 ? (
                      <p className="text-sm text-slate-500">No roles assigned</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {getRoleNames(member.roles || []).map((roleName, idx) => (
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
        </Tabs>
      </div>
    </div>
  );
}
