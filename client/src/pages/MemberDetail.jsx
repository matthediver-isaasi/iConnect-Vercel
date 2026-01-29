import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { useState, useEffect } from "react";
import { Loader2, ArrowLeft, User, Pencil, Save, X, Building2, Mail, Smartphone, PhoneCall, Briefcase, Shield, CalendarDays, LogIn, Users, Globe } from "lucide-react";
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

  // Mutation
  const updateMutation = useMutation({
    mutationFn: (data) => base44.entities.Member.update(id, data),
    onSuccess: () => {
      toast.success("Member updated successfully");
      setIsEditing(false);
      queryClient.invalidateQueries({ queryKey: ['members-crm-list'] });
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
          <TabsTrigger value="roles" className="gap-1" data-testid="tab-member-roles">
            <Shield className="w-4 h-4" />
            Roles
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
      </Tabs>
    </div>
  );
}
