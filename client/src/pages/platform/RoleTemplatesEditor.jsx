import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { 
  Loader2, 
  Plus, 
  Trash2, 
  Save, 
  ChevronDown, 
  ChevronRight,
  Shield,
  AlertTriangle
} from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export default function RoleTemplatesEditor() {
  const { toast } = useToast();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expandedRoles, setExpandedRoles] = useState({});

  useEffect(() => {
    loadRoleTemplates();
  }, []);

  const loadRoleTemplates = async () => {
    try {
      const response = await fetch('/api/platform/role-templates', {
        credentials: 'include'
      });
      const data = await response.json();
      setRoles(data.roles || []);
    } catch (error) {
      toast({ title: 'Error', description: 'Failed to load role templates', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const saveRoleTemplates = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/platform/role-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ roles })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save');
      }

      toast({ title: 'Success', description: 'Role templates saved successfully' });
    } catch (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const addRole = () => {
    const newRole = {
      id: crypto.randomUUID(),
      name: 'New Role',
      is_system: false,
      excluded_features: [],
      member_field_permissions: [],
      organization_field_permissions: []
    };
    setRoles([...roles, newRole]);
    setExpandedRoles({ ...expandedRoles, [newRole.id]: true });
  };

  const updateRole = (index, updates) => {
    const newRoles = [...roles];
    newRoles[index] = { ...newRoles[index], ...updates };
    setRoles(newRoles);
  };

  const deleteRole = (index) => {
    setRoles(roles.filter((_, i) => i !== index));
  };

  const toggleExpanded = (roleId) => {
    setExpandedRoles({ ...expandedRoles, [roleId]: !expandedRoles[roleId] });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {roles.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Shield className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No role templates configured yet.</p>
          <p className="text-sm">Add roles or seed from existing tenant configuration.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {roles.map((role, index) => (
            <Card key={role.id} className="overflow-hidden">
              <Collapsible 
                open={expandedRoles[role.id]} 
                onOpenChange={() => toggleExpanded(role.id)}
              >
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover-elevate py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {expandedRoles[role.id] ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                        <CardTitle className="text-base font-medium">
                          {role.name}
                        </CardTitle>
                        {role.is_system && (
                          <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded">
                            System
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">
                          {role.excluded_features?.length || 0} exclusions
                        </span>
                      </div>
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="border-t pt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Role Name</Label>
                        <Input
                          value={role.name}
                          onChange={(e) => updateRole(index, { name: e.target.value })}
                          data-testid={`input-role-name-${index}`}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>System Role</Label>
                        <div className="flex items-center gap-2 pt-2">
                          <Switch
                            checked={role.is_system}
                            onCheckedChange={(checked) => updateRole(index, { is_system: checked })}
                            data-testid={`switch-system-${index}`}
                          />
                          <span className="text-sm text-muted-foreground">
                            {role.is_system ? 'Protected from deletion' : 'Can be deleted'}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Excluded Features (one per line)</Label>
                      <Textarea
                        value={(role.excluded_features || []).join('\n')}
                        onChange={(e) => updateRole(index, { 
                          excluded_features: e.target.value.split('\n').filter(f => f.trim()) 
                        })}
                        placeholder="feature_key_1&#10;feature_key_2"
                        rows={4}
                        data-testid={`textarea-exclusions-${index}`}
                      />
                      <p className="text-xs text-muted-foreground">
                        Features listed here will be hidden from users with this role.
                      </p>
                    </div>

                    <div className="flex justify-end pt-2">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button 
                            variant="outline" 
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            data-testid={`button-delete-role-${index}`}
                          >
                            <Trash2 className="w-4 h-4 mr-2" />
                            Delete Role
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Role Template?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will remove "{role.name}" from the default role templates.
                              Existing tenants will not be affected.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => deleteRole(index)}>
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-4 border-t">
        <Button 
          variant="outline" 
          onClick={addRole}
          data-testid="button-add-role"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Role Template
        </Button>
        <Button 
          onClick={saveRoleTemplates} 
          disabled={saving}
          data-testid="button-save-templates"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Save Templates
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
