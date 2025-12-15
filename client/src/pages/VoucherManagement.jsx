import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Ticket, Plus, Pencil, Trash2, Search, ChevronLeft, ChevronRight, Building2, Calendar, EyeOff, Eye, AlertCircle, Check, ChevronsUpDown } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const ITEMS_PER_PAGE = 10;

export default function VoucherManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingVoucher, setEditingVoucher] = useState(null);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("all");
  const [showExpired, setShowExpired] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [voucherToDelete, setVoucherToDelete] = useState(null);
  const [orgSearchOpen, setOrgSearchOpen] = useState(false);
  
  const queryClient = useQueryClient();

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_VoucherManagement')) {
        window.location.href = createPageUrl('Dashboard');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady, isFeatureExcluded]);

  const { data: vouchers = [], isLoading: loadingVouchers } = useQuery({
    queryKey: ['vouchers-admin'],
    queryFn: () => base44.entities.Voucher.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  // Sort organizations alphabetically for better UX
  const sortedOrganizations = useMemo(() => {
    return [...organizations].sort((a, b) => 
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    );
  }, [organizations]);

  const filteredVouchers = useMemo(() => {
    let filtered = vouchers;
    
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(v => 
        v.code?.toLowerCase().includes(term) ||
        v.description?.toLowerCase().includes(term) ||
        organizations.find(o => o.id === v.organization_id)?.name?.toLowerCase().includes(term)
      );
    }
    
    if (statusFilter !== "all") {
      filtered = filtered.filter(v => v.status === statusFilter);
    }
    
    if (orgFilter !== "all") {
      filtered = filtered.filter(v => v.organization_id === orgFilter);
    }
    
    if (!showExpired) {
      filtered = filtered.filter(v => {
        if (!v.expires_at) return true;
        return new Date(v.expires_at) >= new Date();
      });
    }
    
    return filtered.sort((a, b) => {
      const dateA = new Date(a.expires_at || 0);
      const dateB = new Date(b.expires_at || 0);
      return dateB.getTime() - dateA.getTime();
    });
  }, [vouchers, searchTerm, statusFilter, orgFilter, showExpired, organizations]);

  const totalPages = Math.ceil(filteredVouchers.length / ITEMS_PER_PAGE);
  const paginatedVouchers = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredVouchers.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredVouchers, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, orgFilter, showExpired]);

  const createMutation = useMutation({
    mutationFn: (data) => base44.entities.Voucher.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
      setShowDialog(false);
      setEditingVoucher(null);
      toast.success('Voucher created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create voucher: ' + error.message);
    }
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.Voucher.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
      setShowDialog(false);
      setEditingVoucher(null);
      toast.success('Voucher updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update voucher: ' + error.message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities.Voucher.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
      setShowDeleteConfirm(false);
      setVoucherToDelete(null);
      toast.success('Voucher deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete voucher: ' + error.message);
    }
  });

  const handleCreateNew = () => {
    setEditingVoucher({
      organization_id: "",
      code: "",
      value: 0,
      description: "",
      expires_at: "",
      status: "active"
    });
    setShowDialog(true);
  };

  const handleEdit = (voucher) => {
    setEditingVoucher({
      ...voucher,
      expires_at: voucher.expires_at ? format(new Date(voucher.expires_at), "yyyy-MM-dd") : ""
    });
    setShowDialog(true);
  };

  const handleDelete = (voucher) => {
    if (voucher.status === 'used') {
      toast.error('Cannot delete a voucher that has been used');
      return;
    }
    setVoucherToDelete(voucher);
    setShowDeleteConfirm(true);
  };

  const handleSave = () => {
    if (!editingVoucher.organization_id) {
      toast.error('Organisation is required');
      return;
    }
    if (!editingVoucher.code.trim()) {
      toast.error('Code is required');
      return;
    }
    if (editingVoucher.value <= 0) {
      toast.error('Value must be greater than 0');
      return;
    }
    if (!editingVoucher.expires_at) {
      toast.error('Expiry date is required');
      return;
    }

    const data = {
      organization_id: editingVoucher.organization_id,
      code: editingVoucher.code.toUpperCase().trim(),
      value: parseFloat(editingVoucher.value),
      description: editingVoucher.description || "",
      expires_at: new Date(editingVoucher.expires_at).toISOString(),
      status: editingVoucher.status
    };

    if (editingVoucher.id) {
      updateMutation.mutate({ id: editingVoucher.id, data });
    } else {
      createMutation.mutate(data);
    }
  };

  const getStatusBadge = (status, expiresAt) => {
    const isExpired = expiresAt && new Date(expiresAt) < new Date();
    
    if (status === 'used') {
      return <Badge className="bg-slate-200 text-slate-700">Used</Badge>;
    }
    if (isExpired || status === 'expired') {
      return <Badge className="bg-red-100 text-red-700">Expired</Badge>;
    }
    if (status === 'active') {
      return <Badge className="bg-green-100 text-green-700">Active</Badge>;
    }
    return <Badge className="bg-slate-200 text-slate-700">{status}</Badge>;
  };

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
              Training Voucher Management
            </h1>
            <p className="text-slate-600">
              Create and manage training vouchers for organisations
            </p>
          </div>
          <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700" data-testid="button-create-voucher">
            <Plus className="w-4 h-4 mr-2" />
            Create Voucher
          </Button>
        </div>

        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by code, description, or organisation..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-vouchers"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="used">Used</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                  </SelectContent>
                </Select>
                
                <Select value={orgFilter} onValueChange={setOrgFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-org-filter">
                    <SelectValue placeholder="Organisation" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organisations</SelectItem>
                    {sortedOrganizations.map(org => (
                      <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <button
                  onClick={() => setShowExpired(!showExpired)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors ${
                    showExpired 
                      ? 'bg-amber-50 border-amber-200 text-amber-700' 
                      : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                  }`}
                  data-testid="button-toggle-expired"
                >
                  {showExpired ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {showExpired ? 'Showing expired' : 'Hiding expired'}
                </button>
                
                <div className="text-sm text-slate-500">
                  {filteredVouchers.length} {filteredVouchers.length === 1 ? 'voucher' : 'vouchers'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {loadingVouchers ? (
          <div className="text-center py-12">Loading vouchers...</div>
        ) : vouchers.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Ticket className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Vouchers Yet
              </h3>
              <p className="text-slate-600 mb-6">
                Create your first training voucher for an organisation
              </p>
              <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Voucher
              </Button>
            </CardContent>
          </Card>
        ) : filteredVouchers.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Matching Vouchers
              </h3>
              <p className="text-slate-600 mb-4">
                No vouchers match your search criteria
              </p>
              <Button 
                variant="outline" 
                onClick={() => { setSearchTerm(""); setStatusFilter("all"); setOrgFilter("all"); setShowExpired(true); }}
              >
                Clear Filters
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {paginatedVouchers.map((voucher) => {
              const org = organizations.find(o => o.id === voucher.organization_id);
              const isExpired = voucher.expires_at && new Date(voucher.expires_at) < new Date();
              const canDelete = voucher.status !== 'used';
              
              return (
                <Card 
                  key={voucher.id} 
                  className={`border-2 ${
                    voucher.status === 'used' ? 'border-slate-200 bg-slate-50' : 
                    isExpired ? 'border-red-200 bg-red-50' :
                    'border-slate-200'
                  }`}
                  data-testid={`card-voucher-${voucher.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <Ticket className="w-5 h-5 text-blue-600 flex-shrink-0" />
                          <span className="text-xl font-bold text-slate-900">{voucher.code}</span>
                          {getStatusBadge(voucher.status, voucher.expires_at)}
                          <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                            £{(voucher.value || 0).toFixed(2)}
                          </Badge>
                        </div>
                        
                        <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
                          <div className="flex items-center gap-1">
                            <Building2 className="w-4 h-4" />
                            <span>{org?.name || 'Unknown Organisation'}</span>
                          </div>
                          {voucher.expires_at && (
                            <div className="flex items-center gap-1">
                              <Calendar className="w-4 h-4" />
                              <span className={isExpired ? 'text-red-600' : ''}>
                                Expires: {format(new Date(voucher.expires_at), 'MMM d, yyyy')}
                              </span>
                            </div>
                          )}
                        </div>
                        
                        {voucher.description && (
                          <p className="text-sm text-slate-500 mt-2">{voucher.description}</p>
                        )}
                        
                        {voucher.used_at && (
                          <p className="text-xs text-slate-400 mt-2">
                            Used on: {format(new Date(voucher.used_at), 'MMM d, yyyy h:mm a')}
                          </p>
                        )}
                      </div>
                      
                      <div className="flex gap-2 flex-shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(voucher)}
                          data-testid={`button-edit-voucher-${voucher.id}`}
                        >
                          <Pencil className="w-3 h-3 mr-1" />
                          Edit
                        </Button>
                        {canDelete && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDelete(voucher)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            data-testid={`button-delete-voucher-${voucher.id}`}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-200">
                <div className="text-sm text-slate-500">
                  Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredVouchers.length)} of {filteredVouchers.length}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Previous
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageNum;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={currentPage === pageNum ? "default" : "outline"}
                          size="sm"
                          onClick={() => setCurrentPage(pageNum)}
                          className="w-9"
                          data-testid={`button-page-${pageNum}`}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {editingVoucher?.id ? 'Edit Voucher' : 'Create New Voucher'}
              </DialogTitle>
            </DialogHeader>
            
            {editingVoucher && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="organization">Organisation *</Label>
                  <Popover open={orgSearchOpen} onOpenChange={setOrgSearchOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={orgSearchOpen}
                        className="w-full justify-between font-normal"
                        data-testid="select-voucher-org"
                      >
                        {editingVoucher.organization_id
                          ? organizations.find(o => o.id === editingVoucher.organization_id)?.name || "Select organisation..."
                          : "Select organisation..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[400px] p-0" align="start">
                      <Command>
                        <CommandInput placeholder="Search organisations..." />
                        <CommandList>
                          <CommandEmpty>No organisation found.</CommandEmpty>
                          <CommandGroup>
                            {sortedOrganizations.map(org => (
                              <CommandItem
                                key={org.id}
                                value={org.name}
                                onSelect={() => {
                                  setEditingVoucher({ ...editingVoucher, organization_id: org.id });
                                  setOrgSearchOpen(false);
                                }}
                                data-testid={`org-option-${org.id}`}
                              >
                                <Check
                                  className={`mr-2 h-4 w-4 ${
                                    editingVoucher.organization_id === org.id ? "opacity-100" : "opacity-0"
                                  }`}
                                />
                                {org.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="code">Voucher Code *</Label>
                    <Input
                      id="code"
                      value={editingVoucher.code}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, code: e.target.value.toUpperCase() })}
                      placeholder="e.g., TRAIN2024"
                      data-testid="input-voucher-code"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="value">Value (£) *</Label>
                    <Input
                      id="value"
                      type="number"
                      step="0.01"
                      min="0"
                      value={editingVoucher.value}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, value: e.target.value })}
                      data-testid="input-voucher-value"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="expires_at">Expiry Date *</Label>
                    <Input
                      id="expires_at"
                      type="date"
                      value={editingVoucher.expires_at}
                      onChange={(e) => setEditingVoucher({ ...editingVoucher, expires_at: e.target.value })}
                      data-testid="input-voucher-expiry"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="status">Status</Label>
                    <Select
                      value={editingVoucher.status}
                      onValueChange={(value) => setEditingVoucher({ ...editingVoucher, status: value })}
                    >
                      <SelectTrigger data-testid="select-voucher-status">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="used">Used</SelectItem>
                        <SelectItem value="expired">Expired</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Input
                    id="description"
                    value={editingVoucher.description || ""}
                    onChange={(e) => setEditingVoucher({ ...editingVoucher, description: e.target.value })}
                    placeholder="e.g., Annual Conference 2024"
                    data-testid="input-voucher-description"
                  />
                </div>
              </div>
            )}
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSave} 
                disabled={createMutation.isPending || updateMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
                data-testid="button-save-voucher"
              >
                {createMutation.isPending || updateMutation.isPending ? 'Saving...' : 'Save Voucher'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-500" />
                Delete Voucher
              </DialogTitle>
            </DialogHeader>
            <p className="text-slate-600">
              Are you sure you want to delete voucher <strong>{voucherToDelete?.code}</strong>? 
              This action cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>
                Cancel
              </Button>
              <Button 
                variant="destructive" 
                onClick={() => deleteMutation.mutate(voucherToDelete.id)}
                disabled={deleteMutation.isPending}
                data-testid="button-confirm-delete"
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
