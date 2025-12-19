import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Pencil, Trash2, Search, UserPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function MemberGroupGuestManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editingGuest, setEditingGuest] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [guestToDelete, setGuestToDelete] = useState(null);

  const queryClient = useQueryClient();

  const { data: guests = [], isLoading } = useQuery({
    queryKey: ['member-group-guests'],
    queryFn: () => base44.entities.MemberGroupGuest.list()
  });

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.MemberGroupGuest.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-guests'] });
      setShowDialog(false);
      setEditingGuest(null);
      toast.success('Guest created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create guest: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.MemberGroupGuest.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-guests'] });
      setShowDialog(false);
      setEditingGuest(null);
      toast.success('Guest updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update guest: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.MemberGroupGuest.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['member-group-guests'] });
      setShowDeleteConfirm(false);
      setGuestToDelete(null);
      toast.success('Guest deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete guest: ' + error.message);
    }
  });

  const handleCreate = () => {
    setEditingGuest({
      first_name: "",
      last_name: "",
      email: "",
      organisation: "",
      job_title: "",
      is_active: true
    });
    setShowDialog(true);
  };

  const handleEdit = (guest) => {
    setEditingGuest({ ...guest });
    setShowDialog(true);
  };

  const handleSave = () => {
    if (!editingGuest.first_name || !editingGuest.last_name || !editingGuest.email) {
      toast.error('First name, last name, and email are required');
      return;
    }

    // Check for duplicate email
    const emailExists = guests.some(
      g => g.id !== editingGuest.id && g.email.toLowerCase() === editingGuest.email.toLowerCase()
    );

    if (emailExists) {
      toast.error('A guest with this email address already exists');
      return;
    }

    const data = {
      first_name: editingGuest.first_name,
      last_name: editingGuest.last_name,
      email: editingGuest.email.toLowerCase(),
      organisation: editingGuest.organisation || "",
      job_title: editingGuest.job_title || "",
      is_active: editingGuest.is_active
    };

    if (editingGuest.id) {
      updateMutation.mutate({ id: editingGuest.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_MemberGroupGuestManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const filteredGuests = guests.filter(guest => {
    const searchLower = searchQuery.toLowerCase();
    return (
      guest.first_name?.toLowerCase().includes(searchLower) ||
      guest.last_name?.toLowerCase().includes(searchLower) ||
      guest.email?.toLowerCase().includes(searchLower) ||
      guest.organisation?.toLowerCase().includes(searchLower)
    );
  });

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Member Group Guests
            </h1>
            <p className="text-slate-600">
              Manage external guests who can be assigned to member groups
            </p>
          </div>
          <Button onClick={handleCreate} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            Add Guest
          </Button>
        </div>

        {/* Search */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
              <Input
                placeholder="Search guests..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </CardContent>
        </Card>

        {/* Guests Table */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          </div>
        ) : filteredGuests.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <UserPlus className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Guests Found</h3>
              <p className="text-slate-600 mb-6">
                {searchQuery ? 'Try adjusting your search' : 'Add your first guest to get started'}
              </p>
              {!searchQuery && (
                <Button onClick={handleCreate} className="bg-blue-600 hover:bg-blue-700">
                  <Plus className="w-4 h-4 mr-2" />
                  Add First Guest
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Organisation</TableHead>
                    <TableHead>Job Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredGuests.map((guest) => (
                    <TableRow key={guest.id}>
                      <TableCell className="font-medium">
                        {guest.first_name} {guest.last_name}
                      </TableCell>
                      <TableCell>{guest.email}</TableCell>
                      <TableCell>{guest.organisation || '-'}</TableCell>
                      <TableCell>{guest.job_title || '-'}</TableCell>
                      <TableCell>
                        <Badge className={guest.is_active !== false ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-700"}>
                          {guest.is_active !== false ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="ghost" size="sm" onClick={() => handleEdit(guest)}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="sm" 
                            className="text-red-600 hover:text-red-700"
                            onClick={() => {
                              setGuestToDelete(guest);
                              setShowDeleteConfirm(true);
                            }}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Edit/Create Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingGuest?.id ? 'Edit Guest' : 'Add Guest'}</DialogTitle>
          </DialogHeader>

          {editingGuest && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="first_name">First Name *</Label>
                  <Input
                    id="first_name"
                    value={editingGuest.first_name}
                    onChange={(e) => setEditingGuest({ ...editingGuest, first_name: e.target.value })}
                    placeholder="First name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="last_name">Last Name *</Label>
                  <Input
                    id="last_name"
                    value={editingGuest.last_name}
                    onChange={(e) => setEditingGuest({ ...editingGuest, last_name: e.target.value })}
                    placeholder="Last name"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={editingGuest.email}
                  onChange={(e) => setEditingGuest({ ...editingGuest, email: e.target.value })}
                  placeholder="email@example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="organisation">Organisation</Label>
                <Input
                  id="organisation"
                  value={editingGuest.organisation || ""}
                  onChange={(e) => setEditingGuest({ ...editingGuest, organisation: e.target.value })}
                  placeholder="Organisation name"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="job_title">Job Title</Label>
                <Input
                  id="job_title"
                  value={editingGuest.job_title || ""}
                  onChange={(e) => setEditingGuest({ ...editingGuest, job_title: e.target.value })}
                  placeholder="Job title"
                />
              </div>

              <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                <Switch
                  id="is_active"
                  checked={editingGuest.is_active !== false}
                  onCheckedChange={(checked) => setEditingGuest({ ...editingGuest, is_active: checked })}
                />
                <Label htmlFor="is_active" className="cursor-pointer">Active</Label>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button 
              onClick={handleSave}
              disabled={createMutation.isPending || updateMutation.isPending}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {editingGuest?.id ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Guest</DialogTitle>
          </DialogHeader>
          <p className="text-slate-600">
            Are you sure you want to delete "{guestToDelete?.first_name} {guestToDelete?.last_name}"? 
            This will also remove them from any group assignments.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
            <Button 
              onClick={() => guestToDelete && deleteMutation.mutate(guestToDelete.id)}
              disabled={deleteMutation.isPending}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}