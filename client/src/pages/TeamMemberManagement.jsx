
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { UserPlus, Users, Pencil, Trash2, AlertCircle, Shield, Mail } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function TeamMemberManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingTeamMember, setEditingTeamMember] = useState(null);
  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [teamMemberToDelete, setTeamMemberToDelete] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_TeamMemberManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: teamMembers = [], isLoading: loadingTeamMembers } = useQuery({
    queryKey: ['team-members'],
    queryFn: () => base44.entities.TeamMember.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const createTeamMemberMutation = useMutation({
    mutationFn: (teamMemberData) => base44.entities.TeamMember.create(teamMemberData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      setShowDialog(false);
      setEditingTeamMember(null);
      toast.success('Team member created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create team member: ' + error.message);
    }
  });

  const updateTeamMemberMutation = useMutation({
    mutationFn: ({ id, teamMemberData }) => base44.entities.TeamMember.update(id, teamMemberData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      setShowDialog(false);
      setEditingTeamMember(null);
      toast.success('Team member updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update team member: ' + error.message);
    }
  });

  const deleteTeamMemberMutation = useMutation({
    mutationFn: (id) => base44.entities.TeamMember.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team-members'] });
      setShowDeleteConfirm(false);
      setTeamMemberToDelete(null);
      toast.success('Team member deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete team member: ' + error.message);
    }
  });

  const handleCreateNew = () => {
    setEditingTeamMember({
      email: "",
      first_name: "",
      last_name: "",
      role_id: "",
      is_active: true
    });
    setShowDialog(true);
  };

  const handleEdit = (teamMember) => {
    setEditingTeamMember({ ...teamMember });
    setShowDialog(true);
  };

  const handleDelete = (teamMember) => {
    setTeamMemberToDelete(teamMember);
    setShowDeleteConfirm(true);
  };

  const handleSave = () => {
    if (!editingTeamMember.email || !editingTeamMember.email.trim()) {
      toast.error('Email is required');
      return;
    }

    if (!editingTeamMember.first_name || !editingTeamMember.first_name.trim()) {
      toast.error('First name is required');
      return;
    }

    if (!editingTeamMember.last_name || !editingTeamMember.last_name.trim()) {
      toast.error('Last name is required');
      return;
    }

    if (!editingTeamMember.role_id) {
      toast.error('Role is required');
      return;
    }

    const teamMemberData = {
      email: editingTeamMember.email.trim(),
      first_name: editingTeamMember.first_name.trim(),
      last_name: editingTeamMember.last_name.trim(),
      role_id: editingTeamMember.role_id,
      is_active: editingTeamMember.is_active
    };

    if (editingTeamMember.id) {
      updateTeamMemberMutation.mutate({
        id: editingTeamMember.id,
        teamMemberData
      });
    } else {
      createTeamMemberMutation.mutate(teamMemberData);
    }
  };

  const getRoleName = (roleId) => {
    const role = roles.find(r => r.id === roleId);
    return role?.name || 'Unknown Role';
  };

  // Deprecated - admin concept removed, access controlled by feature exclusions
  // Kept for backwards compatibility but always returns false
  const getRoleIsAdmin = (roleId) => {
    return false;
  };

  const filteredTeamMembers = teamMembers.filter(tm => {
    const searchLower = searchQuery.toLowerCase();
    return (
      tm.email?.toLowerCase().includes(searchLower) ||
      tm.first_name?.toLowerCase().includes(searchLower) ||
      tm.last_name?.toLowerCase().includes(searchLower)
    );
  });

  const isLoading = loadingTeamMembers || loadingRoles;

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Team Member Management
            </h1>
            <p className="text-slate-600">
              Manage internal team members and administrators
            </p>
          </div>
          <Button onClick={handleCreateNew} className="bg-indigo-600 hover:bg-indigo-700">
            <UserPlus className="w-4 h-4 mr-2" />
            Add Team Member
          </Button>
        </div>

        {/* Search Bar */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
              <Input
                placeholder="Search by name or email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </CardContent>
        </Card>

        {/* Team Members List */}
        {isLoading ? (
          <div className="text-center py-12">Loading team members...</div>
        ) : filteredTeamMembers.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                {searchQuery ? 'No Team Members Found' : 'No Team Members Yet'}
              </h3>
              <p className="text-slate-600 mb-6">
                {searchQuery ? 'Try adjusting your search' : 'Create your first team member to get started'}
              </p>
              {!searchQuery && (
                <Button onClick={handleCreateNew} className="bg-indigo-600 hover:bg-indigo-700">
                  <UserPlus className="w-4 h-4 mr-2" />
                  Add Team Member
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <CardTitle>Team Members ({filteredTeamMembers.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-200">
                {filteredTeamMembers.map((teamMember) => (
                  <div
                    key={teamMember.id}
                    className="flex items-center gap-4 p-4 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-slate-900 truncate">
                          {teamMember.first_name} {teamMember.last_name}
                        </h3>
                        {!teamMember.is_active && (
                          <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                            Inactive
                          </Badge>
                        )}
                        {teamMember.is_active && (
                          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                            Active
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 truncate mb-1">{teamMember.email}</p>
                      <div className="flex items-center gap-2">
                        <Shield className="w-3 h-3 text-slate-400" />
                        <span className="text-xs text-slate-600">{getRoleName(teamMember.role_id)}</span>
                        {getRoleIsAdmin(teamMember.role_id) && (
                          <Badge className="bg-amber-100 text-amber-700 text-xs">Admin</Badge>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEdit(teamMember)}
                      >
                        <Pencil className="w-3 h-3 mr-1" />
                        Edit
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(teamMember)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {editingTeamMember?.id ? 'Edit Team Member' : 'Add New Team Member'}
              </DialogTitle>
            </DialogHeader>
            
            {editingTeamMember && (
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="first-name">First Name *</Label>
                    <Input
                      id="first-name"
                      value={editingTeamMember.first_name}
                      onChange={(e) => setEditingTeamMember({...editingTeamMember, first_name: e.target.value})}
                      placeholder="John"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="last-name">Last Name *</Label>
                    <Input
                      id="last-name"
                      value={editingTeamMember.last_name}
                      onChange={(e) => setEditingTeamMember({...editingTeamMember, last_name: e.target.value})}
                      placeholder="Doe"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email Address *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={editingTeamMember.email}
                    onChange={(e) => setEditingTeamMember({...editingTeamMember, email: e.target.value})}
                    placeholder="john.doe@example.com"
                    disabled={!!editingTeamMember.id}
                  />
                  {editingTeamMember.id && (
                    <p className="text-xs text-slate-500">Email cannot be changed after creation</p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="role">Role *</Label>
                  <Select
                    value={editingTeamMember.role_id}
                    onValueChange={(value) => setEditingTeamMember({...editingTeamMember, role_id: value})}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a role" />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((role) => (
                        <SelectItem key={role.id} value={role.id}>
                          <div className="flex items-center gap-2">
                            <Shield className="w-3 h-3" />
                            {role.name}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Switch
                    id="is-active"
                    checked={editingTeamMember.is_active}
                    onCheckedChange={(checked) => setEditingTeamMember({...editingTeamMember, is_active: checked})}
                  />
                  <div className="flex-1">
                    <Label htmlFor="is-active" className="cursor-pointer">Active Account</Label>
                    <p className="text-xs text-slate-500 mt-1">
                      Inactive accounts cannot log in
                    </p>
                  </div>
                </div>

                {!editingTeamMember.id && (
                  <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
                    <p className="text-xs text-blue-800">
                      After creating this team member, they can log in using their email on the login page. On first login, they will be prompted to create a password.
                    </p>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingTeamMember(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createTeamMemberMutation.isPending || updateTeamMemberMutation.isPending}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                {editingTeamMember?.id ? 'Update Team Member' : 'Create Team Member'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Team Member</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-red-50 rounded-lg">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-900 font-medium">
                    Are you sure you want to delete this team member?
                  </p>
                  {teamMemberToDelete && (
                    <p className="text-xs text-red-700 mt-1">
                      {teamMemberToDelete.first_name} {teamMemberToDelete.last_name} ({teamMemberToDelete.email})
                    </p>
                  )}
                  <p className="text-xs text-red-700 mt-2">
                    This action cannot be undone. They will no longer be able to access the system.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setTeamMemberToDelete(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => teamMemberToDelete && deleteTeamMemberMutation.mutate(teamMemberToDelete.id)}
                disabled={deleteTeamMemberMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Team Member
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
