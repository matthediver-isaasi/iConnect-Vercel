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
import { Users, Plus, Pencil, Trash2, UserPlus, X, Copy, ListPlus, CheckSquare, Calendar } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarComponent } from "@/components/ui/calendar";
import { format } from "date-fns";
import { toast } from "sonner";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function MemberGroupManagementPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showBulkDialog, setShowBulkDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [groupToDelete, setGroupToDelete] = useState(null);
  const [newRole, setNewRole] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [showBulkRoles, setShowBulkRoles] = useState(false);
  const [bulkRolesText, setBulkRolesText] = useState('');
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [showBulkEditDialog, setShowBulkEditDialog] = useState(false);
  const [bulkEditAction, setBulkEditAction] = useState('add');
  const [bulkEditRole, setBulkEditRole] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage] = useState(12);
  const [sortBy, setSortBy] = useState('name-asc');
  const [groupForm, setGroupForm] = useState({
    name: '',
    description: '',
    roles: [],
    is_active: true
  });
  const [assignForm, setAssignForm] = useState({
    member_id: '',
    guest_id: '',
    group_role: '',
    expires_at: null
  });
  const [memberSearchQuery, setMemberSearchQuery] = useState('');
  const [assignMode, setAssignMode] = useState(''); // 'guest' or 'organization'
  const [selectedOrganizationId, setSelectedOrganizationId] = useState('');

  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('membership.member-groups')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: groups = [], isLoading: loadingGroups } = useQuery({
    queryKey: ['member-groups'],
    queryFn: () => base44.entities.MemberGroup.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['members-list'],
    queryFn: () => base44.entities.Member.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: assignments = [], isLoading: loadingAssignments } = useQuery({
    queryKey: ['member-group-assignments'],
    queryFn: () => base44.entities.MemberGroupAssignment.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: guests = [], isLoading: loadingGuests } = useQuery({
    queryKey: ['member-group-guests'],
    queryFn: () => base44.entities.MemberGroupGuest.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Organizations for the assign dialog
  const { data: organizations = [], isLoading: organizationsLoading } = useQuery({
    queryKey: ['organizations-for-assignment'],
    queryFn: async () => {
      const orgs = await base44.entities.Organization.list('name');
      return orgs;
    },
    enabled: showAssignDialog
  });

  // Members filtered by organization (only fetch when dialog is open and organization selected)
  const { data: filteredMembers = [], isLoading: filteredMembersLoading } = useQuery({
    queryKey: ['members-for-group-assignment', selectedOrganizationId],
    queryFn: async () => {
      if (selectedOrganizationId === '__no_org__') {
        // Fetch members without an organization
        const allMembers = await base44.entities.Member.list({ limit: 5000 });
        return allMembers.filter(m => !m.organization_id);
      } else if (selectedOrganizationId) {
        // Fetch members for the selected organization
        return await base44.entities.Member.list({ 
          filter: { organization_id: selectedOrganizationId },
          limit: 1000
        });
      }
      return [];
    },
    enabled: showAssignDialog && assignMode === 'organization' && !!selectedOrganizationId
  });

  const createGroupMutation = useMutation({
    mutationFn: (data) => base44.entities.MemberGroup.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      setShowGroupDialog(false);
      resetGroupForm();
      toast.success('Group created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create group: ' + error.message);
    }
  });

  const updateGroupMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.MemberGroup.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      setShowGroupDialog(false);
      resetGroupForm();
      toast.success('Group updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update group: ' + error.message);
    }
  });

  const deleteGroupMutation = useMutation({
    mutationFn: async (groupId) => {
      const groupAssignments = assignments.filter(a => a.group_id === groupId);
      for (const assignment of groupAssignments) {
        await base44.entities.MemberGroupAssignment.delete(assignment.id);
      }
      await base44.entities.MemberGroup.delete(groupId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      setShowDeleteDialog(false);
      setGroupToDelete(null);
      toast.success('Group deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete group: ' + error.message);
    }
  });

  const assignMemberMutation = useMutation({
    mutationFn: (data) => base44.entities.MemberGroupAssignment.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      setShowAssignDialog(false);
      setAssignForm({ member_id: '', guest_id: '', group_role: '', expires_at: null });
      setAssignMode('');
      setSelectedOrganizationId('');
      setMemberSearchQuery('');
      toast.success('Member assigned successfully');
    },
    onError: (error) => {
      toast.error('Failed to assign member: ' + error.message);
    }
  });

  const removeAssignmentMutation = useMutation({
    mutationFn: (assignmentId) => base44.entities.MemberGroupAssignment.delete(assignmentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-assignments'] });
      toast.success('Member removed from group');
    },
    onError: (error) => {
      toast.error('Failed to remove member: ' + error.message);
    }
  });

  const resetGroupForm = () => {
    setGroupForm({ name: '', description: '', roles: [], is_active: true });
    setEditingGroup(null);
  };

  const handleEditGroup = (group) => {
    setEditingGroup(group);
    setGroupForm({
      name: group.name,
      description: group.description || '',
      roles: group.roles || [],
      is_active: group.is_active
    });
    setShowGroupDialog(true);
  };

  const handleDuplicateGroup = (group) => {
    setEditingGroup(null);
    setGroupForm({
      name: `${group.name} (Copy)`,
      description: group.description || '',
      roles: [...(group.roles || [])],
      is_active: group.is_active
    });
    setShowGroupDialog(true);
  };

  const handleBulkCreate = () => {
    if (!bulkText.trim()) {
      toast.error('Please enter group names');
      return;
    }

    const lines = bulkText.split('\n').filter(line => line.trim());
    const groupsToCreate = lines.map(line => ({
      name: line.trim(),
      description: '',
      roles: [],
      is_active: true
    }));

    Promise.all(groupsToCreate.map(g => base44.entities.MemberGroup.create(g)))
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['member-groups'] });
        setShowBulkDialog(false);
        setBulkText('');
        toast.success(`Created ${groupsToCreate.length} groups successfully`);
      })
      .catch(error => {
        toast.error('Failed to create groups: ' + error.message);
      });
  };

  const handleSaveGroup = () => {
    if (!groupForm.name.trim()) {
      toast.error('Group name is required');
      return;
    }

    if (editingGroup) {
      updateGroupMutation.mutate({ id: editingGroup.id, data: groupForm });
    } else {
      createGroupMutation.mutate(groupForm);
    }
  };

  const handleAddRole = () => {
    if (!newRole.trim()) return;
    if (groupForm.roles.includes(newRole.trim())) {
      toast.error('Role already exists');
      return;
    }
    setGroupForm({ ...groupForm, roles: [...groupForm.roles, newRole.trim()] });
    setNewRole('');
  };

  const handleBulkAddRoles = () => {
    if (!bulkRolesText.trim()) {
      toast.error('Please enter role names');
      return;
    }

    const lines = bulkRolesText.split('\n').filter(line => line.trim());
    const newRoles = lines.map(line => line.trim());
    const existingRoles = groupForm.roles || [];
    
    // Filter out duplicates
    const uniqueNewRoles = newRoles.filter(role => !existingRoles.includes(role));
    
    if (uniqueNewRoles.length === 0) {
      toast.error('All roles already exist');
      return;
    }

    setGroupForm({ ...groupForm, roles: [...existingRoles, ...uniqueNewRoles] });
    setBulkRolesText('');
    setShowBulkRoles(false);
    toast.success(`Added ${uniqueNewRoles.length} role(s)`);
  };

  const handleRemoveRole = (role) => {
    setGroupForm({ ...groupForm, roles: groupForm.roles.filter(r => r !== role) });
  };

  const handleAssignMember = () => {
    if ((!assignForm.member_id && !assignForm.guest_id) || !assignForm.group_role) {
      toast.error('Please select a member/guest and role');
      return;
    }

    // Check for existing assignment
    const existing = assignments.find(a => {
      if (a.group_id !== selectedGroup.id) return false;
      if (assignForm.member_id && a.member_id === assignForm.member_id) return true;
      if (assignForm.guest_id && a.guest_id === assignForm.guest_id) return true;
      return false;
    });

    if (existing) {
      toast.error('This person is already assigned to this group');
      return;
    }

    const data = {
      group_role: assignForm.group_role,
      group_id: selectedGroup.id
    };

    if (assignForm.member_id) {
      data.member_id = assignForm.member_id;
    } else if (assignForm.guest_id) {
      data.guest_id = assignForm.guest_id;
    }
    
    if (assignForm.expires_at) {
      data.expires_at = format(assignForm.expires_at, 'yyyy-MM-dd');
    }

    assignMemberMutation.mutate(data);
  };

  const getGroupAssignments = (groupId) => {
    return assignments.filter(a => a.group_id === groupId);
  };

  const getMemberName = (memberId) => {
    const member = members.find(m => m.id === memberId);
    return member ? `${member.first_name} ${member.last_name}` : 'Unknown';
  };

  const getGuestName = (guestId) => {
    const guest = guests.find(g => g.id === guestId);
    return guest ? `${guest.first_name} ${guest.last_name}` : 'Unknown Guest';
  };

  const getAssigneeName = (assignment) => {
    if (assignment.member_id) {
      return getMemberName(assignment.member_id);
    } else if (assignment.guest_id) {
      return getGuestName(assignment.guest_id);
    }
    return 'Unknown';
  };

  const isAssignmentGuest = (assignment) => {
    return !!assignment.guest_id;
  };

  // Filter and sort groups
  const filteredAndSortedGroups = React.useMemo(() => {
    let filtered = groups.filter(group => {
      const matchesSearch = searchQuery === '' || 
        group.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (group.description && group.description.toLowerCase().includes(searchQuery.toLowerCase()));
      return matchesSearch;
    });

    // Sort groups
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'name-asc':
          return a.name.localeCompare(b.name);
        case 'name-desc':
          return b.name.localeCompare(a.name);
        case 'members-asc': {
          const aCount = getGroupAssignments(a.id).length;
          const bCount = getGroupAssignments(b.id).length;
          return aCount - bCount;
        }
        case 'members-desc': {
          const aCount = getGroupAssignments(a.id).length;
          const bCount = getGroupAssignments(b.id).length;
          return bCount - aCount;
        }
        default:
          return 0;
      }
    });

    return filtered;
  }, [groups, searchQuery, sortBy, assignments]);

  // Pagination
  const totalPages = Math.ceil(filteredAndSortedGroups.length / itemsPerPage);
  const paginatedGroups = filteredAndSortedGroups.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  // Reset to page 1 when search/sort changes
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, sortBy]);

  const handleSelectGroup = (groupId) => {
    setSelectedGroups(prev => 
      prev.includes(groupId) 
        ? prev.filter(id => id !== groupId)
        : [...prev, groupId]
    );
  };

  const handleSelectAll = () => {
    if (selectedGroups.length === groups.length) {
      setSelectedGroups([]);
    } else {
      setSelectedGroups(groups.map(g => g.id));
    }
  };

  const bulkUpdateGroupsMutation = useMutation({
    mutationFn: async ({ groupIds, action, role }) => {
      const updates = [];
      for (const groupId of groupIds) {
        const group = groups.find(g => g.id === groupId);
        if (!group) continue;

        let newRoles = [...(group.roles || [])];
        
        if (action === 'add') {
          if (!newRoles.includes(role)) {
            newRoles.push(role);
          }
        } else if (action === 'remove') {
          newRoles = newRoles.filter(r => r !== role);
        }

        updates.push(
          base44.entities.MemberGroup.update(groupId, { roles: newRoles })
        );
      }
      await Promise.all(updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-groups'] });
      setShowBulkEditDialog(false);
      setBulkEditRole('');
      setSelectedGroups([]);
      toast.success('Groups updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update groups: ' + error.message);
    }
  });

  const handleBulkEdit = () => {
    if (!bulkEditRole.trim()) {
      toast.error('Please enter a role name');
      return;
    }
    if (selectedGroups.length === 0) {
      toast.error('Please select at least one group');
      return;
    }

    bulkUpdateGroupsMutation.mutate({
      groupIds: selectedGroups,
      action: bulkEditAction,
      role: bulkEditRole.trim()
    });
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <p className="text-slate-600">Loading...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Member Groups</h1>
              <p className="text-slate-600">Create and manage member groups with roles</p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setShowBulkDialog(true)} variant="outline">
                <ListPlus className="w-4 h-4 mr-2" />
                Bulk Create
              </Button>
              <Button onClick={() => setShowGroupDialog(true)} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                New Group
              </Button>
            </div>
          </div>

          {groups.length > 0 && (
            <>
              <Card className="bg-blue-50 border-blue-200 mb-4">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleSelectAll}
                        className="bg-white"
                      >
                        <CheckSquare className="w-4 h-4 mr-2" />
                        {selectedGroups.length === groups.length ? 'Deselect All' : 'Select All'}
                      </Button>
                      {selectedGroups.length > 0 && (
                        <span className="text-sm font-medium text-blue-900">
                          {selectedGroups.length} group{selectedGroups.length !== 1 ? 's' : ''} selected
                        </span>
                      )}
                    </div>
                    {selectedGroups.length > 0 && (
                      <Button
                        onClick={() => setShowBulkEditDialog(true)}
                        className="bg-blue-600 hover:bg-blue-700"
                        size="sm"
                      >
                        <Users className="w-4 h-4 mr-2" />
                        Bulk Edit Roles
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="mb-6">
                <CardContent className="p-4">
                  <div className="flex flex-col md:flex-row gap-3">
                    <div className="flex-1">
                      <Input
                        placeholder="Search groups..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full"
                      />
                    </div>
                    <div className="w-full md:w-64">
                      <Select value={sortBy} onValueChange={setSortBy}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="name-asc">Name (A-Z)</SelectItem>
                          <SelectItem value="name-desc">Name (Z-A)</SelectItem>
                          <SelectItem value="members-desc">Most Members</SelectItem>
                          <SelectItem value="members-asc">Least Members</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {filteredAndSortedGroups.length > 0 && (
                    <p className="text-sm text-slate-600 mt-3">
                      Showing {filteredAndSortedGroups.length} of {groups.length} group{groups.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </div>

        {loadingGroups || loadingMembers || loadingAssignments || loadingGuests ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {Array(6).fill(0).map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-6 bg-slate-200 rounded w-3/4 mb-2" />
                  <div className="h-4 bg-slate-200 rounded w-full" />
                </CardHeader>
              </Card>
            ))}
          </div>
        ) : groups.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Groups Yet</h3>
              <p className="text-slate-600 mb-6">Create your first member group to get started</p>
              <Button onClick={() => setShowGroupDialog(true)} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Group
              </Button>
            </CardContent>
          </Card>
        ) : filteredAndSortedGroups.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Groups Found</h3>
              <p className="text-slate-600 mb-4">No groups match your search criteria</p>
              <Button variant="outline" onClick={() => setSearchQuery('')}>
                Clear Search
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {paginatedGroups.map((group) => {
              const groupAssignments = getGroupAssignments(group.id);
              const isSelected = selectedGroups.includes(group.id);
              return (
                <Card 
                  key={group.id} 
                  className={`hover:shadow-lg transition-shadow ${isSelected ? 'ring-2 ring-blue-500' : ''}`}
                >
                  <CardHeader>
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => handleSelectGroup(group.id)}
                        className="w-4 h-4 cursor-pointer"
                      />
                      <div className="flex items-start justify-between flex-1">
                        <CardTitle className="text-lg">{group.name}</CardTitle>
                        {!group.is_active && (
                          <Badge className="bg-slate-200 text-slate-700">Inactive</Badge>
                        )}
                      </div>
                    </div>
                    {group.description && (
                      <p className="text-sm text-slate-600">{group.description}</p>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <span className="text-sm font-medium text-slate-700">Roles:</span>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {group.roles?.length > 0 ? (
                          group.roles.map((role, idx) => (
                            <Badge key={idx} className="bg-blue-100 text-blue-700 text-xs">
                              {role}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-slate-500">No roles defined</span>
                        )}
                      </div>
                    </div>

                    <div>
                      <span className="text-sm font-medium text-slate-700">
                        Members: {groupAssignments.length}
                      </span>
                    </div>

                    <div className="flex gap-2 pt-2 border-t border-slate-200">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedGroup(group);
                          setShowAssignDialog(true);
                        }}
                        className="flex-1"
                      >
                        <UserPlus className="w-3 h-3 mr-1" />
                        Assign
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDuplicateGroup(group)}
                        title="Duplicate"
                      >
                        <Copy className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleEditGroup(group)}
                      >
                        <Pencil className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setGroupToDelete(group);
                          setShowDeleteDialog(true);
                        }}
                        className="text-red-600 hover:text-red-700"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>

                    {groupAssignments.length > 0 && (
                    <div className="pt-2 border-t border-slate-200">
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {groupAssignments.map((assignment) => (
                        <div key={assignment.id} className="flex items-center justify-between text-xs bg-slate-50 p-2 rounded">
                          <div>
                            <div className="font-medium text-slate-900 flex items-center gap-1">
                              {getAssigneeName(assignment)}
                              {isAssignmentGuest(assignment) && (
                                <Badge className="bg-purple-100 text-purple-700 text-[10px] px-1">Guest</Badge>
                              )}
                            </div>
                            <div className="text-slate-500">{assignment.group_role}</div>
                            {assignment.expires_at && (
                              <div className="text-slate-400 flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                Expires: {format(new Date(assignment.expires_at), 'dd MMM yyyy')}
                              </div>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => removeAssignmentMutation.mutate(assignment.id)}
                            className="h-6 w-6 p-0 text-red-600 hover:text-red-700"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                    </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-8 flex justify-center">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>
                <div className="flex items-center gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                    <Button
                      key={page}
                      variant={currentPage === page ? "default" : "outline"}
                      size="sm"
                      onClick={() => setCurrentPage(page)}
                      className={currentPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                    >
                      {page}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
        )}

        {/* Create/Edit Group Dialog */}
        <Dialog open={showGroupDialog} onOpenChange={setShowGroupDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editingGroup ? 'Edit Group' : 'Create New Group'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Group Name *</Label>
                <Input
                  id="name"
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder="e.g., Board of Directors"
                />
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={groupForm.description}
                  onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  placeholder="Description of this group..."
                  rows={3}
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Roles within Group</Label>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setShowBulkRoles(!showBulkRoles)}
                    type="button"
                  >
                    <ListPlus className="w-3 h-3 mr-1" />
                    Bulk Add
                  </Button>
                </div>

                {showBulkRoles ? (
                  <div className="space-y-2 mb-2 p-3 bg-slate-50 rounded-lg">
                    <Textarea
                      value={bulkRolesText}
                      onChange={(e) => setBulkRolesText(e.target.value)}
                      placeholder="Chair&#10;Vice Chair&#10;Secretary&#10;Treasurer&#10;Member"
                      rows={5}
                    />
                    <div className="flex gap-2">
                      <Button onClick={handleBulkAddRoles} type="button" size="sm" className="flex-1">
                        Add Roles
                      </Button>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => { setShowBulkRoles(false); setBulkRolesText(''); }}
                        type="button"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 mb-2">
                    <Input
                      value={newRole}
                      onChange={(e) => setNewRole(e.target.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleAddRole()}
                      placeholder="e.g., Chair, Vice Chair, Member"
                    />
                    <Button onClick={handleAddRole} type="button">
                      <Plus className="w-4 h-4" />
                    </Button>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  {groupForm.roles.map((role, idx) => (
                    <Badge key={idx} className="bg-blue-100 text-blue-700">
                      {role}
                      <button
                        onClick={() => handleRemoveRole(role)}
                        className="ml-2 hover:text-red-600"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="is_active"
                  checked={groupForm.is_active}
                  onChange={(e) => setGroupForm({ ...groupForm, is_active: e.target.checked })}
                  className="w-4 h-4"
                />
                <Label htmlFor="is_active" className="cursor-pointer">Active</Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowGroupDialog(false); resetGroupForm(); }}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveGroup}
                disabled={createGroupMutation.isPending || updateGroupMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingGroup ? 'Update' : 'Create'} Group
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Assign Member Dialog */}
        <Dialog open={showAssignDialog} onOpenChange={(open) => {
          setShowAssignDialog(open);
          if (!open) {
            setMemberSearchQuery('');
            setAssignMode('');
            setSelectedOrganizationId('');
            setAssignForm({ member_id: '', guest_id: '', group_role: '', expires_at: null });
          }
        }}>
          <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Assign Member to {selectedGroup?.name}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-4 flex-1 overflow-hidden flex flex-col">
              {/* Step 1: Select Mode (Guest or Organization) */}
              <div className="space-y-2">
                <Label>Step 1: Select Category *</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={assignMode === 'guest' ? 'default' : 'outline'}
                    onClick={() => {
                      setAssignMode('guest');
                      setSelectedOrganizationId('');
                      setAssignForm({ ...assignForm, member_id: '', guest_id: '' });
                      setMemberSearchQuery('');
                    }}
                    className={assignMode === 'guest' ? 'bg-purple-600 hover:bg-purple-700' : ''}
                  >
                    Guests
                  </Button>
                  <Button
                    type="button"
                    variant={assignMode === 'organization' ? 'default' : 'outline'}
                    onClick={() => {
                      setAssignMode('organization');
                      setAssignForm({ ...assignForm, member_id: '', guest_id: '' });
                      setMemberSearchQuery('');
                    }}
                    className={assignMode === 'organization' ? 'bg-blue-600 hover:bg-blue-700' : ''}
                  >
                    Members by Organisation
                  </Button>
                </div>
              </div>

              {/* Step 2: For Organization mode, select organization */}
              {assignMode === 'organization' && (
                <div className="space-y-2">
                  <Label>Step 2: Select Organisation *</Label>
                  <Select 
                    value={selectedOrganizationId} 
                    onValueChange={(val) => {
                      setSelectedOrganizationId(val);
                      setAssignForm({ ...assignForm, member_id: '', guest_id: '' });
                      setMemberSearchQuery('');
                    }}
                  >
                    <SelectTrigger data-testid="select-organization">
                      <SelectValue placeholder={organizationsLoading ? "Loading organisations..." : "Select an organisation..."} />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      <SelectItem value="__no_org__">Members without organisation</SelectItem>
                      {organizations.map(org => (
                        <SelectItem key={org.id} value={org.id}>
                          {org.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Step 3: Select Member/Guest */}
              {((assignMode === 'guest') || (assignMode === 'organization' && selectedOrganizationId)) && (
                <div className="space-y-2 flex-1 overflow-hidden flex flex-col">
                  <Label>{assignMode === 'guest' ? 'Step 2: Select Guest *' : 'Step 3: Select Member *'}</Label>
                  <Input
                    value={memberSearchQuery}
                    onChange={(e) => setMemberSearchQuery(e.target.value)}
                    placeholder="Search by name or email..."
                    className="mb-2"
                  />
                  <div className="border border-slate-200 rounded-md flex-1 overflow-y-auto min-h-[150px] max-h-[200px]">
                    {assignMode === 'guest' ? (
                      /* Guest list */
                      <>
                        {guests
                          .filter(guest => {
                            if (guest.is_active === false) return false;
                            const searchLower = memberSearchQuery.toLowerCase();
                            return (
                              guest.first_name?.toLowerCase().includes(searchLower) ||
                              guest.last_name?.toLowerCase().includes(searchLower) ||
                              guest.email?.toLowerCase().includes(searchLower) ||
                              guest.organisation?.toLowerCase().includes(searchLower)
                            );
                          })
                          .map((guest) => (
                            <button
                              key={`guest-${guest.id}`}
                              type="button"
                              onClick={() => setAssignForm({ ...assignForm, guest_id: guest.id, member_id: '' })}
                              className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0 ${
                                assignForm.guest_id === guest.id ? 'bg-purple-50 border-l-4 border-l-purple-600' : ''
                              }`}
                            >
                              <div className="font-medium text-slate-900 flex items-center gap-2">
                                {guest.first_name} {guest.last_name}
                                <Badge className="bg-purple-100 text-purple-700 text-[10px]">Guest</Badge>
                              </div>
                              <div className="text-xs text-slate-500">{guest.email}</div>
                              {guest.organisation && (
                                <div className="text-xs text-slate-400">{guest.organisation}</div>
                              )}
                            </button>
                          ))}
                        {guests.filter(guest => {
                          if (guest.is_active === false) return false;
                          const searchLower = memberSearchQuery.toLowerCase();
                          return (
                            guest.first_name?.toLowerCase().includes(searchLower) ||
                            guest.last_name?.toLowerCase().includes(searchLower) ||
                            guest.email?.toLowerCase().includes(searchLower) ||
                            guest.organisation?.toLowerCase().includes(searchLower)
                          );
                        }).length === 0 && (
                          <div className="px-3 py-4 text-center text-sm text-slate-500">
                            No guests found
                          </div>
                        )}
                      </>
                    ) : (
                      /* Members list filtered by organization */
                      <>
                        {filteredMembersLoading ? (
                          <div className="px-3 py-4 text-center text-sm text-slate-500">
                            Loading members...
                          </div>
                        ) : (
                          <>
                            {filteredMembers
                              .filter(member => {
                                const searchLower = memberSearchQuery.toLowerCase();
                                return (
                                  member.first_name?.toLowerCase().includes(searchLower) ||
                                  member.last_name?.toLowerCase().includes(searchLower) ||
                                  member.email?.toLowerCase().includes(searchLower)
                                );
                              })
                              .map((member) => (
                                <button
                                  key={`member-${member.id}`}
                                  type="button"
                                  onClick={() => setAssignForm({ ...assignForm, member_id: member.id, guest_id: '' })}
                                  className={`w-full text-left px-3 py-2 hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-b-0 ${
                                    assignForm.member_id === member.id ? 'bg-blue-50 border-l-4 border-l-blue-600' : ''
                                  }`}
                                >
                                  <div className="font-medium text-slate-900">
                                    {member.first_name} {member.last_name}
                                  </div>
                                  <div className="text-xs text-slate-500">{member.email}</div>
                                </button>
                              ))}
                            {filteredMembers.filter(member => {
                              const searchLower = memberSearchQuery.toLowerCase();
                              return (
                                member.first_name?.toLowerCase().includes(searchLower) ||
                                member.last_name?.toLowerCase().includes(searchLower) ||
                                member.email?.toLowerCase().includes(searchLower)
                              );
                            }).length === 0 && (
                              <div className="px-3 py-4 text-center text-sm text-slate-500">
                                No members found in this organisation
                              </div>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Role selection */}
              {(assignForm.member_id || assignForm.guest_id) && (
                <div className="space-y-2">
                  <Label>{assignMode === 'guest' ? 'Step 3' : 'Step 4'}: Select Role *</Label>
                  <Select
                    value={assignForm.group_role}
                    onValueChange={(value) => setAssignForm({ ...assignForm, group_role: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose a role..." />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedGroup?.roles?.map((role, idx) => (
                        <SelectItem key={idx} value={role}>
                          {role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Expiry Date */}
              {(assignForm.member_id || assignForm.guest_id) && (
                <div className="space-y-2">
                  <Label>Expiry Date (Optional)</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="w-full justify-start text-left font-normal"
                      >
                        <Calendar className="mr-2 h-4 w-4" />
                        {assignForm.expires_at ? format(assignForm.expires_at, 'PPP') : 'No expiry date'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComponent
                        mode="single"
                        selected={assignForm.expires_at}
                        onSelect={(date) => setAssignForm({ ...assignForm, expires_at: date })}
                        initialFocus
                      />
                      {assignForm.expires_at && (
                        <div className="p-2 border-t">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            onClick={() => setAssignForm({ ...assignForm, expires_at: null })}
                          >
                            Clear date
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAssignDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleAssignMember}
                disabled={assignMemberMutation.isPending || (!assignForm.member_id && !assignForm.guest_id) || !assignForm.group_role}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Assign Member
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Bulk Create Dialog */}
        <Dialog open={showBulkDialog} onOpenChange={setShowBulkDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Bulk Create Groups</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label htmlFor="bulk-text">Group Names (one per line)</Label>
                <Textarea
                  id="bulk-text"
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder="Board of Directors&#10;Finance Committee&#10;Audit Committee&#10;Nominations Committee"
                  rows={10}
                />
                <p className="text-xs text-slate-500 mt-1">
                  Enter one group name per line. Roles can be added later.
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowBulkDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleBulkCreate}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Create Groups
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Bulk Edit Roles Dialog */}
        <Dialog open={showBulkEditDialog} onOpenChange={setShowBulkEditDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Bulk Edit Roles for {selectedGroups.length} Group{selectedGroups.length !== 1 ? 's' : ''}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Action</Label>
                <Select
                  value={bulkEditAction}
                  onValueChange={setBulkEditAction}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="add">Add Role</SelectItem>
                    <SelectItem value="remove">Remove Role</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="bulk-role">Role Name *</Label>
                <Input
                  id="bulk-role"
                  value={bulkEditRole}
                  onChange={(e) => setBulkEditRole(e.target.value)}
                  placeholder="e.g., Chair, Member, etc."
                />
                <p className="text-xs text-slate-500 mt-1">
                  {bulkEditAction === 'add' 
                    ? 'This role will be added to all selected groups (if not already present)'
                    : 'This role will be removed from all selected groups (if present)'}
                </p>
              </div>

              <div className="bg-slate-50 p-3 rounded-lg">
                <p className="text-sm font-medium text-slate-700 mb-2">Selected Groups:</p>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {selectedGroups.map(groupId => {
                    const group = groups.find(g => g.id === groupId);
                    return (
                      <div key={groupId} className="text-xs text-slate-600 flex items-center gap-2">
                        <span>•</span>
                        <span>{group?.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowBulkEditDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleBulkEdit}
                disabled={bulkUpdateGroupsMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {bulkEditAction === 'add' ? 'Add' : 'Remove'} Role
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete Group</DialogTitle>
            </DialogHeader>
            <p className="text-slate-600">
              Are you sure you want to delete <strong>{groupToDelete?.name}</strong>? 
              This will also remove all member assignments to this group. This action cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => deleteGroupMutation.mutate(groupToDelete.id)}
                disabled={deleteGroupMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Group
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}