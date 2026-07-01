import React, { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { apiRequest } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Pencil, Trash2, Search, UserPlus, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
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

  // Email validation state
  const [emailValidating, setEmailValidating] = useState(false);
  const [emailError, setEmailError] = useState(null);

  // Org type-ahead state
  const [orgSearchQuery, setOrgSearchQuery] = useState("");
  const [orgResults, setOrgResults] = useState([]);
  const [orgSearching, setOrgSearching] = useState(false);
  const [orgConflict, setOrgConflict] = useState(false);
  const orgDebounceRef = useRef(null);

  const queryClient = useQueryClient();

  const { data: guests = [], isLoading } = useQuery({
    queryKey: ['member-group-guests'],
    queryFn: () => base44.entities.MemberGroupGuest.list()
  });

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-list'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 5 * 60 * 1000
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

  const [saving, setSaving] = useState(false);

  const handleCreate = () => {
    setEditingGuest({
      first_name: "",
      last_name: "",
      email: "",
      organisation: "",
      job_title: "",
      role_id: "",
      is_active: true
    });
    setEmailError(null);
    setOrgSearchQuery("");
    setOrgResults([]);
    setOrgConflict(false);
    setShowDialog(true);
  };

  const handleEdit = (guest) => {
    setEditingGuest({ ...guest, role_id: guest.role_id || "" });
    setEmailError(null);
    setOrgSearchQuery(guest.organisation || "");
    setOrgResults([]);
    setOrgConflict(false);
    setShowDialog(true);
  };

  const handleEmailBlur = async () => {
    const email = (editingGuest?.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setEmailError(null);
      return;
    }
    // Skip check when editing the same guest's existing email
    if (editingGuest?.id && email === (guests.find(g => g.id === editingGuest.id)?.email || "").toLowerCase()) {
      setEmailError(null);
      return;
    }
    setEmailValidating(true);
    setEmailError(null);
    try {
      const resp = await fetch(
        `/api/members/search?q=${encodeURIComponent(email)}&limit=5`,
        { credentials: 'include' }
      );
      if (resp.ok) {
        const results = await resp.json();
        const exact = (results || []).find(
          (m) => (m.email || "").toLowerCase() === email
        );
        if (exact) {
          setEmailError("This email already belongs to a member of this tenant.");
        }
      }
    } catch (e) {
      // Non-fatal: backend will enforce
    } finally {
      setEmailValidating(false);
    }
  };

  const handleOrgChange = (value) => {
    setEditingGuest((prev) => ({ ...prev, organisation: value }));
    setOrgSearchQuery(value);
    setOrgConflict(false);

    if (orgDebounceRef.current) clearTimeout(orgDebounceRef.current);
    if (!value.trim()) {
      setOrgResults([]);
      setOrgSearching(false);
      return;
    }
    setOrgSearching(true);
    orgDebounceRef.current = setTimeout(async () => {
      try {
        const resp = await fetch(
          `/api/admin/organizations/paginated?search=${encodeURIComponent(value.trim())}&limit=5&fields=id,name`,
          { credentials: 'include' }
        );
        if (resp.ok) {
          const data = await resp.json();
          const orgs = data.organizations || data.items || data || [];
          setOrgResults(orgs);
          // Block if any org name exactly matches (case-insensitive)
          const lower = value.trim().toLowerCase();
          const conflict = orgs.some((o) => (o.name || "").toLowerCase() === lower);
          setOrgConflict(conflict);
        } else {
          setOrgResults([]);
        }
      } catch (e) {
        setOrgResults([]);
      } finally {
        setOrgSearching(false);
      }
    }, 350);
  };

  const handleSave = async () => {
    if (!editingGuest.first_name || !editingGuest.last_name || !editingGuest.email) {
      toast.error('First name, last name, and email are required');
      return;
    }
    if (!editingGuest.id && !editingGuest.role_id) {
      toast.error('Please select a role for the guest');
      return;
    }
    if (emailError) {
      toast.error(emailError);
      return;
    }
    if (orgConflict) {
      toast.error('The organisation name matches an existing tenant organisation. Group guests must come from a new (external) organisation.');
      return;
    }

    setSaving(true);
    try {
      if (editingGuest.id) {
        // Update via provision PATCH (syncs both marker + member)
        await apiRequest('PATCH', '/api/member-group-guests/provision', {
          id: editingGuest.id,
          first_name: editingGuest.first_name,
          last_name: editingGuest.last_name,
          email: editingGuest.email.trim().toLowerCase(),
          organisation: editingGuest.organisation || "",
          job_title: editingGuest.job_title || "",
          is_active: editingGuest.is_active,
          role_id: editingGuest.role_id || undefined
        });
        toast.success('Guest updated successfully');
      } else {
        // Create via provision POST (creates member + marker)
        await apiRequest('POST', '/api/member-group-guests/provision', {
          first_name: editingGuest.first_name,
          last_name: editingGuest.last_name,
          email: editingGuest.email.trim().toLowerCase(),
          organisation: editingGuest.organisation || "",
          job_title: editingGuest.job_title || "",
          role_id: editingGuest.role_id
        });
        toast.success('Guest created successfully');
      }
      queryClient.invalidateQueries({ queryKey: ['member-group-guests'] });
      queryClient.invalidateQueries({ queryKey: ['members-list'] });
      setShowDialog(false);
      setEditingGuest(null);
    } catch (err) {
      const msg = err?.message || 'Failed to save guest';
      // 409 = email conflict
      if (msg.includes('email') || msg.includes('Email') || msg.includes('409')) {
        setEmailError("This email already belongs to a member of this tenant.");
      }
      toast.error(msg);
    } finally {
      setSaving(false);
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

  const getRoleName = (roleId) => {
    const role = roles.find((r) => r.id === roleId);
    return role ? role.name : null;
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
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
                        {guest.member_id && (
                          <Badge className="ml-2 bg-blue-100 text-blue-700 text-[10px]">Provisioned</Badge>
                        )}
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
      <Dialog open={showDialog} onOpenChange={(open) => { setShowDialog(open); if (!open) setEditingGuest(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingGuest?.id ? 'Edit Guest' : 'Add Guest'}</DialogTitle>
          </DialogHeader>

          {editingGuest && (
            <div className="space-y-4">
              {/* Name row */}
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

              {/* Email with live validation */}
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <div className="relative">
                  <Input
                    id="email"
                    type="email"
                    value={editingGuest.email}
                    onChange={(e) => {
                      setEditingGuest({ ...editingGuest, email: e.target.value });
                      setEmailError(null);
                    }}
                    onBlur={handleEmailBlur}
                    placeholder="email@example.com"
                    className={emailError ? "border-red-400 pr-8" : ""}
                  />
                  {emailValidating && (
                    <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400" />
                  )}
                </div>
                {emailError && (
                  <p className="text-sm text-red-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 flex-shrink-0" />
                    {emailError}
                  </p>
                )}
              </div>

              {/* RBAC Role selector — required for new guests, optional update for existing */}
              <div className="space-y-2">
                <Label htmlFor="role_id">
                  Role {!editingGuest.id ? '*' : ''}
                </Label>
                <Select
                  value={editingGuest.role_id || ''}
                  onValueChange={(val) => setEditingGuest({ ...editingGuest, role_id: val })}
                >
                  <SelectTrigger id="role_id">
                    <SelectValue placeholder="Select a role..." />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500">
                  {!editingGuest.id
                    ? 'The RBAC role applied to the guest\'s member record. Required.'
                    : 'Update the role applied to the guest\'s member record.'}
                </p>
              </div>

              {/* Organisation type-ahead */}
              <div className="space-y-2">
                <Label htmlFor="organisation">Organisation</Label>
                <div className="relative">
                  <Input
                    id="organisation"
                    value={editingGuest.organisation || ""}
                    onChange={(e) => handleOrgChange(e.target.value)}
                    placeholder="Organisation name"
                    className={orgConflict ? "border-red-400" : ""}
                    autoComplete="off"
                  />
                  {orgSearching && (
                    <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400" />
                  )}
                </div>
                {orgConflict && (
                  <p className="text-sm text-red-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 flex-shrink-0" />
                    This matches an existing tenant organisation. Guests must be from an external organisation.
                  </p>
                )}
                {!orgConflict && orgResults.length > 0 && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 flex-shrink-0" />
                    Partial matches found: {orgResults.map(o => o.name).join(', ')}. Make sure the name is distinct.
                  </p>
                )}
                {!orgConflict && !orgSearching && orgResults.length === 0 && (editingGuest.organisation || "").trim() && (
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="w-3 h-3 flex-shrink-0" />
                    No existing organisation found with this name.
                  </p>
                )}
              </div>

              {/* Job Title */}
              <div className="space-y-2">
                <Label htmlFor="job_title">Job Title</Label>
                <Input
                  id="job_title"
                  value={editingGuest.job_title || ""}
                  onChange={(e) => setEditingGuest({ ...editingGuest, job_title: e.target.value })}
                  placeholder="Job title"
                />
              </div>

              {/* Active toggle (only on edit) */}
              {editingGuest.id && (
                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Switch
                    id="is_active"
                    checked={editingGuest.is_active !== false}
                    onCheckedChange={(checked) => setEditingGuest({ ...editingGuest, is_active: checked })}
                  />
                  <Label htmlFor="is_active" className="cursor-pointer">Active</Label>
                </div>
              )}

              {!editingGuest.id && (
                <p className="text-xs text-slate-500 bg-blue-50 border border-blue-100 rounded-md p-3">
                  Creating a guest will provision a real member account with login access. The guest can then be assigned to member groups, gaining access to group features (forums, events, projects) per their group role.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={saving || !!emailError || orgConflict}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
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
            This will remove them from any group assignments.
            {guestToDelete?.member_id && (
              <span className="block mt-2 text-amber-600 text-sm">
                Note: Their member account will not be deleted — only the guest marker row will be removed.
              </span>
            )}
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
