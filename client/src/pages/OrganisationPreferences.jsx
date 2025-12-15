import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Building2, Shield, Save, Eye, EyeOff, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const CORE_ORG_FIELDS = [
  { key: 'name', label: 'Organisation Name', description: 'The name of the organisation' },
  { key: 'description', label: 'Description', description: 'Organisation description/about' },
  { key: 'phone', label: 'Phone Number', description: 'Contact phone number' },
  { key: 'website_url', label: 'Website', description: 'Organisation website URL' },
  { key: 'invoicing_email', label: 'Invoicing Email', description: 'Email for invoicing purposes' },
  { key: 'invoicing_address', label: 'Invoicing Address', description: 'Address for invoicing' },
  { key: 'logo_url', label: 'Logo', description: 'Organisation logo image' },
];

const PERMISSION_OPTIONS = [
  { value: 'read_write', label: 'Read & Write', icon: Pencil, color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100' },
  { value: 'read', label: 'Read Only', icon: Eye, color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100' },
  { value: 'hidden', label: 'Hidden', icon: EyeOff, color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200' },
];

export default function OrganisationPreferencesPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [hasChanges, setHasChanges] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_admin_OrganisationPreferences')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady, isFeatureExcluded]);

  const { data: roles = [], isLoading: rolesLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    enabled: accessChecked,
  });

  const { data: orgCustomFields = [] } = useQuery({
    queryKey: ['org-preference-fields'],
    queryFn: async () => {
      const fields = await base44.entities.PreferenceField.list({
        filter: { is_active: true, entity_scope: 'organization' },
        sort: { display_order: 'asc' }
      });
      return (fields || []).filter(f => f.entity_scope === 'organization');
    },
    enabled: accessChecked,
  });

  const { data: rolePermissions = {}, isLoading: permissionsLoading, refetch: refetchPermissions } = useQuery({
    queryKey: ['role-org-field-permissions', selectedRoleId],
    queryFn: async () => {
      if (!selectedRoleId) return {};
      const response = await fetch(`/api/roles/${selectedRoleId}/organization-field-permissions`, {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error('Failed to fetch permissions');
      }
      return response.json();
    },
    enabled: !!selectedRoleId && accessChecked,
  });

  useEffect(() => {
    if (selectedRoleId && rolePermissions) {
      const allFields = [...CORE_ORG_FIELDS.map(f => f.key), ...orgCustomFields.map(f => f.id)];
      const initialPermissions = {};
      allFields.forEach(fieldKey => {
        initialPermissions[fieldKey] = rolePermissions[fieldKey] || 'read_write';
      });
      setPermissions(initialPermissions);
      setHasChanges(false);
    }
  }, [selectedRoleId, rolePermissions, orgCustomFields]);

  const updatePermissionsMutation = useMutation({
    mutationFn: async (permissionsData) => {
      const response = await fetch(`/api/roles/${selectedRoleId}/organization-field-permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(permissionsData)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update permissions');
      }
      return response.json();
    },
    onSuccess: () => {
      toast.success('Permissions saved successfully');
      setHasChanges(false);
      queryClient.invalidateQueries({ queryKey: ['role-org-field-permissions', selectedRoleId] });
    },
    onError: (error) => {
      toast.error(error.message || 'Failed to save permissions');
    }
  });

  const handlePermissionChange = (fieldKey, newPermission) => {
    setPermissions(prev => ({
      ...prev,
      [fieldKey]: newPermission
    }));
    setHasChanges(true);
  };

  const handleSave = () => {
    updatePermissionsMutation.mutate(permissions);
  };

  const handleRoleChange = (roleId) => {
    if (hasChanges) {
      if (!confirm('You have unsaved changes. Are you sure you want to switch roles?')) {
        return;
      }
    }
    setSelectedRoleId(roleId);
  };

  const getPermissionBadge = (permission) => {
    const option = PERMISSION_OPTIONS.find(o => o.value === permission) || PERMISSION_OPTIONS[0];
    const Icon = option.icon;
    return (
      <Badge className={`${option.color} flex items-center gap-1`}>
        <Icon className="w-3 h-3" />
        {option.label}
      </Badge>
    );
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <Building2 className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
              Organisation Preferences
            </h1>
          </div>
          <p className="text-slate-600">
            Configure which organisation fields are visible and editable for each role on the My Organisation page.
          </p>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Select Role
            </CardTitle>
            <CardDescription>
              Choose a role to configure its organisation field permissions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <Select
                value={selectedRoleId || ''}
                onValueChange={handleRoleChange}
                disabled={rolesLoading}
              >
                <SelectTrigger className="w-[300px]" data-testid="select-role">
                  <SelectValue placeholder="Select a role..." />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                      {role.is_admin && <Badge className="ml-2" variant="secondary">Admin</Badge>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              
              {hasChanges && (
                <Button
                  onClick={handleSave}
                  disabled={updatePermissionsMutation.isPending}
                  data-testid="button-save-permissions"
                >
                  {updatePermissionsMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save Changes
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {selectedRoleId && (
          <>
            {permissionsLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : (
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Core Organisation Fields</CardTitle>
                    <CardDescription>
                      Standard fields available on all organisations
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {CORE_ORG_FIELDS.map((field) => (
                        <div
                          key={field.key}
                          className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg"
                        >
                          <div>
                            <p className="font-medium text-slate-900 dark:text-slate-100">{field.label}</p>
                            <p className="text-sm text-slate-500 dark:text-slate-400">{field.description}</p>
                          </div>
                          <Select
                            value={permissions[field.key] || 'read_write'}
                            onValueChange={(value) => handlePermissionChange(field.key, value)}
                          >
                            <SelectTrigger className="w-[160px]" data-testid={`select-permission-${field.key}`}>
                              <SelectValue>
                                {getPermissionBadge(permissions[field.key] || 'read_write')}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              {PERMISSION_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  <div className="flex items-center gap-2">
                                    <option.icon className="w-4 h-4" />
                                    {option.label}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {orgCustomFields.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Custom Organisation Fields</CardTitle>
                      <CardDescription>
                        Custom fields defined for organisations
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {orgCustomFields.map((field) => (
                          <div
                            key={field.id}
                            className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg"
                          >
                            <div>
                              <p className="font-medium text-slate-900 dark:text-slate-100">{field.label}</p>
                              <p className="text-sm text-slate-500 dark:text-slate-400">
                                {field.field_type} field
                                {field.is_required && <Badge variant="outline" className="ml-2">Required</Badge>}
                              </p>
                            </div>
                            <Select
                              value={permissions[field.id] || 'read_write'}
                              onValueChange={(value) => handlePermissionChange(field.id, value)}
                            >
                              <SelectTrigger className="w-[160px]" data-testid={`select-permission-${field.id}`}>
                                <SelectValue>
                                  {getPermissionBadge(permissions[field.id] || 'read_write')}
                                </SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {PERMISSION_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    <div className="flex items-center gap-2">
                                      <option.icon className="w-4 h-4" />
                                      {option.label}
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                  <h4 className="font-medium text-blue-900 dark:text-blue-100 mb-2">Permission Levels</h4>
                  <ul className="space-y-1 text-sm text-blue-800 dark:text-blue-200">
                    <li className="flex items-center gap-2">
                      <Pencil className="w-4 h-4" />
                      <strong>Read & Write:</strong> Members can view and edit this field
                    </li>
                    <li className="flex items-center gap-2">
                      <Eye className="w-4 h-4" />
                      <strong>Read Only:</strong> Members can view but not edit this field
                    </li>
                    <li className="flex items-center gap-2">
                      <EyeOff className="w-4 h-4" />
                      <strong>Hidden:</strong> This field is not shown to members with this role
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </>
        )}

        {!selectedRoleId && (
          <Card>
            <CardContent className="p-12 text-center">
              <Shield className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
                Select a Role
              </h3>
              <p className="text-slate-600 dark:text-slate-400">
                Choose a role from the dropdown above to configure its organisation field permissions.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
