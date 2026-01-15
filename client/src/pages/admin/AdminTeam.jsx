import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { 
  Users, 
  ArrowLeft, 
  Plus, 
  MoreHorizontal, 
  Shield, 
  Mail, 
  Loader2,
  UserPlus,
  Trash2,
  Edit,
  Crown,
  Eye,
  CreditCard
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

const ROLE_CONFIG = {
  owner: { label: 'Owner', icon: Crown, color: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200' },
  admin: { label: 'Admin', icon: Shield, color: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' },
  billing: { label: 'Billing', icon: CreditCard, color: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
  viewer: { label: 'Viewer', icon: Eye, color: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200' }
};

export default function AdminTeam() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [newMember, setNewMember] = useState({ email: '', first_name: '', last_name: '', role: 'admin' });

  const { data: teamData, isLoading } = useQuery({
    queryKey: ['tenant-team'],
    queryFn: async () => {
      const response = await fetch('/api/tenant/team', { credentials: 'include' });
      if (!response.ok) {
        if (response.status === 401) {
          navigate('/admin/login');
          throw new Error('Not authenticated');
        }
        throw new Error('Failed to fetch team');
      }
      return response.json();
    }
  });

  const addMemberMutation = useMutation({
    mutationFn: async (data) => {
      const response = await fetch('/api/tenant/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data)
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to add team member');
      }
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['tenant-team'] });
      setShowAddDialog(false);
      setNewMember({ email: '', first_name: '', last_name: '', role: 'admin' });
      toast.success(data.member?.is_new_user 
        ? 'Team member added. They will receive an email to set their password.'
        : 'Team member added successfully'
      );
    },
    onError: (error) => {
      toast.error(error.message);
    }
  });

  const updateMemberMutation = useMutation({
    mutationFn: async ({ membership_id, role, status }) => {
      const response = await fetch('/api/tenant/team', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ membership_id, role, status })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update team member');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-team'] });
      setShowEditDialog(false);
      setSelectedMember(null);
      toast.success('Team member updated');
    },
    onError: (error) => {
      toast.error(error.message);
    }
  });

  const deleteMemberMutation = useMutation({
    mutationFn: async (membership_id) => {
      const response = await fetch('/api/tenant/team', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ membership_id })
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to remove team member');
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tenant-team'] });
      setShowDeleteDialog(false);
      setSelectedMember(null);
      toast.success('Team member removed');
    },
    onError: (error) => {
      toast.error(error.message);
    }
  });

  const handleAddMember = () => {
    if (!newMember.email) {
      toast.error('Email is required');
      return;
    }
    addMemberMutation.mutate(newMember);
  };

  const handleUpdateRole = (role) => {
    if (!selectedMember) return;
    updateMemberMutation.mutate({ membership_id: selectedMember.id, role });
  };

  const handleDeleteMember = () => {
    if (!selectedMember) return;
    deleteMemberMutation.mutate(selectedMember.id);
  };

  const members = teamData?.members || [];

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center gap-4 mb-6">
          <Link to="/admin/dashboard">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <div className="flex-1">
            <h1 className="text-2xl font-bold" data-testid="text-page-title">Team</h1>
            <p className="text-muted-foreground">Manage who has access to this admin portal</p>
          </div>
          <Button onClick={() => setShowAddDialog(true)} data-testid="button-add-member">
            <UserPlus className="w-4 h-4 mr-2" />
            Add Team Member
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Team Members
            </CardTitle>
            <CardDescription>
              {members.length} {members.length === 1 ? 'member' : 'members'} with admin access
            </CardDescription>
          </CardHeader>
          <CardContent>
            {members.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
                <p>No team members yet</p>
              </div>
            ) : (
              <div className="divide-y">
                {members.map((member) => {
                  const roleConfig = ROLE_CONFIG[member.role] || ROLE_CONFIG.viewer;
                  const RoleIcon = roleConfig.icon;
                  
                  return (
                    <div 
                      key={member.id} 
                      className="flex items-center gap-4 py-4"
                      data-testid={`team-member-${member.id}`}
                    >
                      <Avatar className="w-10 h-10">
                        <AvatarImage src={member.profile_picture_url} />
                        <AvatarFallback>
                          {member.first_name?.[0]}{member.last_name?.[0]}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">
                            {member.first_name || member.last_name 
                              ? `${member.first_name || ''} ${member.last_name || ''}`.trim()
                              : 'No name'
                            }
                          </p>
                          {member.is_current_user && (
                            <Badge variant="outline" className="text-xs">You</Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground truncate">{member.email}</p>
                        {member.last_login && (
                          <p className="text-xs text-muted-foreground">
                            Last active {formatDistanceToNow(new Date(member.last_login), { addSuffix: true })}
                          </p>
                        )}
                      </div>
                      <Badge className={`${roleConfig.color} flex items-center gap-1`}>
                        <RoleIcon className="w-3 h-3" />
                        {roleConfig.label}
                      </Badge>
                      {!member.is_current_user && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" data-testid={`button-member-menu-${member.id}`}>
                              <MoreHorizontal className="w-4 h-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem 
                              onClick={() => {
                                setSelectedMember(member);
                                setShowEditDialog(true);
                              }}
                              data-testid={`menu-item-change-role-${member.id}`}
                            >
                              <Edit className="w-4 h-4 mr-2" />
                              Change Role
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              className="text-destructive"
                              onClick={() => {
                                setSelectedMember(member);
                                setShowDeleteDialog(true);
                              }}
                              data-testid={`menu-item-remove-${member.id}`}
                            >
                              <Trash2 className="w-4 h-4 mr-2" />
                              Remove
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Team Member</DialogTitle>
            <DialogDescription>
              Invite someone to help manage this tenant. They will receive an email to set their password if they don't already have an account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                placeholder="colleague@company.com"
                value={newMember.email}
                onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
                data-testid="input-email"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="first_name">First Name</Label>
                <Input
                  id="first_name"
                  placeholder="John"
                  value={newMember.first_name}
                  onChange={(e) => setNewMember({ ...newMember, first_name: e.target.value })}
                  data-testid="input-first-name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="last_name">Last Name</Label>
                <Input
                  id="last_name"
                  placeholder="Doe"
                  value={newMember.last_name}
                  onChange={(e) => setNewMember({ ...newMember, last_name: e.target.value })}
                  data-testid="input-last-name"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select 
                value={newMember.role} 
                onValueChange={(value) => setNewMember({ ...newMember, role: value })}
              >
                <SelectTrigger data-testid="select-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner">
                    <div className="flex items-center gap-2">
                      <Crown className="w-4 h-4" />
                      Owner - Full access
                    </div>
                  </SelectItem>
                  <SelectItem value="admin">
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4" />
                      Admin - Manage settings
                    </div>
                  </SelectItem>
                  <SelectItem value="billing">
                    <div className="flex items-center gap-2">
                      <CreditCard className="w-4 h-4" />
                      Billing - Manage payments
                    </div>
                  </SelectItem>
                  <SelectItem value="viewer">
                    <div className="flex items-center gap-2">
                      <Eye className="w-4 h-4" />
                      Viewer - Read only
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)} data-testid="button-cancel-add">
              Cancel
            </Button>
            <Button 
              onClick={handleAddMember} 
              disabled={addMemberMutation.isPending}
              data-testid="button-confirm-add"
            >
              {addMemberMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent data-testid="dialog-edit-role">
          <DialogHeader>
            <DialogTitle>Change Role</DialogTitle>
            <DialogDescription>
              Update the role for {selectedMember?.email}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select 
              value={selectedMember?.role || 'admin'} 
              onValueChange={handleUpdateRole}
            >
              <SelectTrigger data-testid="select-edit-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">
                  <div className="flex items-center gap-2">
                    <Crown className="w-4 h-4" />
                    Owner - Full access
                  </div>
                </SelectItem>
                <SelectItem value="admin">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4" />
                    Admin - Manage settings
                  </div>
                </SelectItem>
                <SelectItem value="billing">
                  <div className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4" />
                    Billing - Manage payments
                  </div>
                </SelectItem>
                <SelectItem value="viewer">
                  <div className="flex items-center gap-2">
                    <Eye className="w-4 h-4" />
                    Viewer - Read only
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)} data-testid="button-cancel-edit">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent data-testid="dialog-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Team Member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove {selectedMember?.email} from the team? They will no longer have access to this admin portal.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteMember}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-delete"
            >
              {deleteMemberMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <Trash2 className="w-4 h-4 mr-2" />
              )}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
