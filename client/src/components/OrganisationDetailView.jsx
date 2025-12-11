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
import { 
  Building2, 
  ArrowLeft, 
  Globe, 
  Users, 
  Phone, 
  Mail, 
  MapPin, 
  Pencil, 
  Save, 
  X, 
  Camera,
  Loader2,
  ExternalLink,
  User,
  Calendar,
  ClipboardList,
  Wallet,
  FileText
} from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function OrganisationDetailView({ 
  organization, 
  onBack, 
  orgCustomFields = [],
  memberCount = 0 
}) {
  const { isAdmin } = useMemberAccess();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [formData, setFormData] = useState({
    name: '',
    status: 'active',
    phone: '',
    website_url: '',
    invoicing_email: '',
    invoicing_address: '',
    description: '',
    training_fund_balance: 0
  });
  const [customFieldValues, setCustomFieldValues] = useState({});

  const { data: orgMembers = [], isLoading: membersLoading } = useQuery({
    queryKey: ['org-detail-members', organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      const members = await base44.entities.Member.list({
        filter: { organization_id: organization.id }
      });
      return members || [];
    }
  });

  const { data: orgValues = [], isLoading: valuesLoading } = useQuery({
    queryKey: ['org-detail-preference-values', organization?.id],
    enabled: !!organization?.id,
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list({
          filter: { organization_id: organization.id }
        });
        return values || [];
      } catch {
        return [];
      }
    }
  });

  const { data: orgBookings = [], isLoading: bookingsLoading } = useQuery({
    queryKey: ['org-detail-bookings', organization?.id, orgMembers.length],
    enabled: !!organization?.id && activeTab === 'activity' && orgMembers.length > 0,
    queryFn: async () => {
      try {
        // Only fetch bookings for members of this organisation
        const memberIds = orgMembers.map(m => m.id);
        if (memberIds.length === 0) return [];
        
        // Fetch bookings for each member (limited approach to avoid loading all bookings)
        const bookingPromises = memberIds.slice(0, 10).map(memberId => 
          base44.entities.Booking.list({ filter: { member_id: memberId } })
        );
        const results = await Promise.all(bookingPromises);
        const allBookings = results.flat().sort((a, b) => 
          new Date(b.created_date || 0) - new Date(a.created_date || 0)
        );
        return allBookings.slice(0, 20); // Limit to 20 most recent
      } catch {
        return [];
      }
    }
  });

  useEffect(() => {
    if (organization) {
      setFormData({
        name: organization.name || '',
        status: organization.status || 'active',
        phone: organization.phone || '',
        website_url: organization.website_url || '',
        invoicing_email: organization.invoicing_email || '',
        invoicing_address: organization.invoicing_address || '',
        description: organization.description || '',
        training_fund_balance: organization.training_fund_balance || 0
      });
    }
  }, [organization]);

  useEffect(() => {
    if (orgValues.length > 0 && orgCustomFields.length > 0) {
      const valuesMap = {};
      orgValues.forEach(pv => {
        const field = orgCustomFields.find(f => f.id === pv.field_id);
        if (field?.field_type === 'picklist' && pv.value) {
          try {
            valuesMap[pv.field_id] = JSON.parse(pv.value);
          } catch {
            valuesMap[pv.field_id] = pv.value;
          }
        } else {
          valuesMap[pv.field_id] = pv.value;
        }
      });
      setCustomFieldValues(valuesMap);
    }
  }, [orgValues, orgCustomFields]);

  const updateOrgMutation = useMutation({
    mutationFn: async (updates) => {
      return await base44.entities.Organization.update(organization.id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations-crm-list'] });
      toast.success('Organisation updated successfully');
      setIsEditing(false);
    },
    onError: (error) => {
      toast.error('Failed to update organisation: ' + error.message);
    }
  });

  const updateCustomFieldMutation = useMutation({
    mutationFn: async ({ fieldId, value }) => {
      const existingValue = orgValues.find(v => v.field_id === fieldId);
      const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value);
      
      if (existingValue) {
        return await base44.entities.OrganizationPreferenceValue.update(existingValue.id, { value: storedValue });
      } else {
        return await base44.entities.OrganizationPreferenceValue.create({
          organization_id: organization.id,
          field_id: fieldId,
          value: storedValue
        });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['org-detail-preference-values', organization?.id] });
      queryClient.invalidateQueries({ queryKey: ['all-org-preference-values-crm'] });
    }
  });

  const handleSave = () => {
    updateOrgMutation.mutate(formData);
    
    Object.entries(customFieldValues).forEach(([fieldId, value]) => {
      const existingVal = orgValues.find(v => v.field_id === fieldId);
      const storedValue = Array.isArray(value) ? JSON.stringify(value) : String(value || '');
      const existingStored = existingVal?.value || '';
      
      if (storedValue !== existingStored) {
        updateCustomFieldMutation.mutate({ fieldId, value });
      }
    });
  };

  const handleCancel = () => {
    setFormData({
      name: organization.name || '',
      status: organization.status || 'active',
      phone: organization.phone || '',
      website_url: organization.website_url || '',
      invoicing_email: organization.invoicing_email || '',
      invoicing_address: organization.invoicing_address || '',
      description: organization.description || '',
      training_fund_balance: organization.training_fund_balance || 0
    });
    
    const valuesMap = {};
    orgValues.forEach(pv => {
      const field = orgCustomFields.find(f => f.id === pv.field_id);
      if (field?.field_type === 'picklist' && pv.value) {
        try {
          valuesMap[pv.field_id] = JSON.parse(pv.value);
        } catch {
          valuesMap[pv.field_id] = pv.value;
        }
      } else {
        valuesMap[pv.field_id] = pv.value;
      }
    });
    setCustomFieldValues(valuesMap);
    setIsEditing(false);
  };

  const renderFieldEditor = (field) => {
    const value = customFieldValues[field.id];
    
    switch (field.field_type) {
      case 'text':
        return (
          <Input
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={!isEditing}
            data-testid={`input-custom-${field.id}`}
          />
        );
      case 'number':
      case 'decimal':
        return (
          <Input
            type="number"
            step={field.field_type === 'decimal' ? '0.01' : '1'}
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={!isEditing}
            data-testid={`input-custom-${field.id}`}
          />
        );
      case 'dropdown':
        return (
          <Select
            value={value || ''}
            onValueChange={(v) => setCustomFieldValues(prev => ({ ...prev, [field.id]: v }))}
            disabled={!isEditing}
          >
            <SelectTrigger data-testid={`select-custom-${field.id}`}>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              {(field.options || []).map((opt, idx) => (
                <SelectItem key={idx} value={opt.value}>{opt.label || opt.value}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      case 'picklist':
        const selectedValues = Array.isArray(value) ? value : [];
        return (
          <div className="space-y-2">
            {(field.options || []).map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Checkbox
                  checked={selectedValues.includes(opt.value)}
                  onCheckedChange={(checked) => {
                    if (!isEditing) return;
                    const newValues = checked 
                      ? [...selectedValues, opt.value]
                      : selectedValues.filter(v => v !== opt.value);
                    setCustomFieldValues(prev => ({ ...prev, [field.id]: newValues }));
                  }}
                  disabled={!isEditing}
                  data-testid={`checkbox-custom-${field.id}-${opt.value}`}
                />
                <span className="text-sm">{opt.label || opt.value}</span>
              </div>
            ))}
          </div>
        );
      default:
        return (
          <Input
            value={value || ''}
            onChange={(e) => setCustomFieldValues(prev => ({ ...prev, [field.id]: e.target.value }))}
            disabled={!isEditing}
          />
        );
    }
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back">
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div className="flex items-center gap-4">
                {organization.logo_url ? (
                  <img src={organization.logo_url} alt={organization.name} className="w-14 h-14 rounded-lg object-contain bg-slate-100" />
                ) : (
                  <div className="w-14 h-14 rounded-lg bg-blue-100 flex items-center justify-center">
                    <Building2 className="w-7 h-7 text-blue-600" />
                  </div>
                )}
                <div>
                  <h1 className="text-xl font-semibold text-slate-900">{organization.name}</h1>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant={organization.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                      {organization.status || 'unknown'}
                    </Badge>
                    <span className="text-sm text-slate-500 flex items-center gap-1">
                      <Users className="w-4 h-4" />
                      {memberCount} members
                    </span>
                  </div>
                </div>
              </div>
            </div>
            
            {isAdmin && (
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <>
                    <Button variant="outline" onClick={handleCancel} data-testid="button-cancel-edit">
                      <X className="w-4 h-4 mr-2" />
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleSave} 
                      disabled={updateOrgMutation.isPending}
                      data-testid="button-save-org"
                    >
                      {updateOrgMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4 mr-2" />
                      )}
                      Save Changes
                    </Button>
                  </>
                ) : (
                  <Button onClick={() => setIsEditing(true)} data-testid="button-edit-org">
                    <Pencil className="w-4 h-4 mr-2" />
                    Edit
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
        
        <Tabs value={activeTab} onValueChange={setActiveTab} className="px-6">
          <TabsList className="bg-transparent border-b-0">
            <TabsTrigger value="overview" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-overview">
              Overview
            </TabsTrigger>
            <TabsTrigger value="members" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-members">
              Members
            </TabsTrigger>
            <TabsTrigger value="activity" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 rounded-none" data-testid="tab-activity">
              Activity
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <main className="p-6">
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-blue-600" />
                    Organisation Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-slate-500">Organisation Name</Label>
                      {isEditing ? (
                        <Input
                          value={formData.name}
                          onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                          data-testid="input-org-name"
                        />
                      ) : (
                        <p className="font-medium">{formData.name || '-'}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-500">Status</Label>
                      {isEditing ? (
                        <Select value={formData.status} onValueChange={(v) => setFormData(prev => ({ ...prev, status: v }))}>
                          <SelectTrigger data-testid="select-org-status">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="active">Active</SelectItem>
                            <SelectItem value="inactive">Inactive</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant={formData.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                          {formData.status || 'unknown'}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-slate-500">Description</Label>
                    {isEditing ? (
                      <Textarea
                        value={formData.description}
                        onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                        rows={3}
                        data-testid="textarea-org-description"
                      />
                    ) : (
                      <p className="text-slate-700">{formData.description || 'No description provided'}</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Mail className="w-4 h-4 text-blue-600" />
                    Contact Information
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-slate-500 flex items-center gap-1">
                        <Mail className="w-3 h-3" /> Invoicing Email
                      </Label>
                      {isEditing ? (
                        <Input
                          type="email"
                          value={formData.invoicing_email}
                          onChange={(e) => setFormData(prev => ({ ...prev, invoicing_email: e.target.value }))}
                          data-testid="input-invoicing-email"
                        />
                      ) : (
                        <p>{formData.invoicing_email || '-'}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-500 flex items-center gap-1">
                        <Phone className="w-3 h-3" /> Phone
                      </Label>
                      {isEditing ? (
                        <Input
                          value={formData.phone}
                          onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                          data-testid="input-phone"
                        />
                      ) : (
                        <p>{formData.phone || '-'}</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-500 flex items-center gap-1">
                        <Globe className="w-3 h-3" /> Website
                      </Label>
                      {isEditing ? (
                        <Input
                          value={formData.website_url}
                          onChange={(e) => setFormData(prev => ({ ...prev, website_url: e.target.value }))}
                          data-testid="input-website"
                        />
                      ) : formData.website_url ? (
                        <a href={formData.website_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1">
                          {formData.website_url}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <p>-</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label className="text-slate-500 flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> Invoicing Address
                      </Label>
                      {isEditing ? (
                        <Textarea
                          value={formData.invoicing_address}
                          onChange={(e) => setFormData(prev => ({ ...prev, invoicing_address: e.target.value }))}
                          rows={2}
                          data-testid="textarea-address"
                        />
                      ) : (
                        <p className="whitespace-pre-line">{formData.invoicing_address || '-'}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {orgCustomFields.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <ClipboardList className="w-4 h-4 text-blue-600" />
                      Custom Fields
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {orgCustomFields.map(field => (
                        <div key={field.id} className="space-y-2">
                          <Label className="text-slate-500">{field.label}</Label>
                          {renderFieldEditor(field)}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-green-600" />
                    Training Fund
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-center py-4">
                    <p className="text-3xl font-bold text-green-600">
                      £{(formData.training_fund_balance || 0).toFixed(2)}
                    </p>
                    <p className="text-sm text-slate-500 mt-1">Available Balance</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Users className="w-4 h-4 text-blue-600" />
                    Team Overview
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">Total Members</span>
                      <span className="font-medium">{orgMembers.length}</span>
                    </div>
                    <Separator />
                    <div className="space-y-2">
                      {orgMembers.slice(0, 5).map(member => (
                        <div key={member.id} className="flex items-center gap-2 text-sm">
                          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                            <User className="w-4 h-4 text-slate-400" />
                          </div>
                          <div>
                            <p className="font-medium text-slate-700">{member.full_name || member.email}</p>
                            <p className="text-xs text-slate-400">{member.job_title || 'Member'}</p>
                          </div>
                        </div>
                      ))}
                      {orgMembers.length > 5 && (
                        <p className="text-xs text-slate-400 text-center pt-2">
                          +{orgMembers.length - 5} more members
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {activeTab === 'members' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-600" />
                Organisation Members ({orgMembers.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {membersLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : orgMembers.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <Users className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No members in this organisation</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Name</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Email</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Job Title</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 uppercase">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {orgMembers.map(member => (
                        <tr key={member.id} className="hover:bg-slate-50" data-testid={`row-member-${member.id}`}>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                                <User className="w-4 h-4 text-blue-600" />
                              </div>
                              <span className="font-medium text-slate-900">{member.full_name || '-'}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{member.email}</td>
                          <td className="px-4 py-3 text-slate-600">{member.job_title || '-'}</td>
                          <td className="px-4 py-3">
                            <Badge variant={member.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                              {member.status || 'unknown'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeTab === 'activity' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="w-5 h-5 text-blue-600" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bookingsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : orgBookings.length === 0 ? (
                <div className="text-center py-12 text-slate-500">
                  <Calendar className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No recent activity</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {orgBookings.slice(0, 10).map(booking => (
                    <div key={booking.id} className="flex items-start gap-4 p-4 bg-slate-50 rounded-lg" data-testid={`activity-${booking.id}`}>
                      <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                        <Calendar className="w-5 h-5 text-blue-600" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">{booking.event_title || 'Event Booking'}</p>
                        <p className="text-sm text-slate-500">
                          {booking.created_date ? new Date(booking.created_date).toLocaleDateString('en-GB') : 'Unknown date'}
                        </p>
                        <Badge variant="outline" className="mt-2 capitalize">{booking.status || 'confirmed'}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
