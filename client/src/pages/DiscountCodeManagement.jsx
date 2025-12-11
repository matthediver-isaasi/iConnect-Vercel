import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Ticket, Plus, Pencil, Copy, Trash2, AlertCircle, Building2, Globe } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function DiscountCodeManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [editingCode, setEditingCode] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_DiscountCodeManagement')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady, isFeatureExcluded]);
  const [showDialog, setShowDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [codeToDelete, setCodeToDelete] = useState(null);
  
  const queryClient = useQueryClient();

  const { data: discountCodes = [], isLoading: loadingCodes } = useQuery({
    queryKey: ['discount-codes'],
    queryFn: () => base44.entities.DiscountCode.list('-created_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: organizations = [] } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: programs = [] } = useQuery({
    queryKey: ['programs'],
    queryFn: () => base44.entities.Program.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: usageRecords = [] } = useQuery({
    queryKey: ['discount-usage'],
    queryFn: () => base44.entities.DiscountCodeUsage.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const createCodeMutation = useMutation({
    mutationFn: (codeData) => base44.entities.DiscountCode.create(codeData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      setShowDialog(false);
      setEditingCode(null);
      toast.success('Discount code created successfully');
    },
    onError: (error) => {
      toast.error('Failed to create discount code: ' + error.message);
    }
  });

  const updateCodeMutation = useMutation({
    mutationFn: ({ id, codeData }) => base44.entities.DiscountCode.update(id, codeData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      setShowDialog(false);
      setEditingCode(null);
      toast.success('Discount code updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update discount code: ' + error.message);
    }
  });

  const deleteCodeMutation = useMutation({
    mutationFn: (id) => base44.entities.DiscountCode.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      setShowDeleteConfirm(false);
      setCodeToDelete(null);
      toast.success('Discount code deleted successfully');
    },
    onError: (error) => {
      toast.error('Failed to delete discount code: ' + error.message);
    }
  });

  // Check if discount code can be deleted (not used)
  const canDeleteCode = (code) => {
    if (code.organization_id) {
      // Organization-specific: check DiscountCodeUsage
      const usage = usageRecords.find(ur => 
        ur.discount_code_id === code.id && ur.organization_id === code.organization_id
      );
      return !usage || usage.usage_count === 0;
    } else {
      // Global: check current_usage_count
      return (code.current_usage_count || 0) === 0;
    }
  };

  const handleCreateNew = () => {
    setEditingCode({
      code: "",
      type: "percentage",
      value: 0,
      description: "",
      is_active: false,
      expires_at: "",
      min_purchase_amount: 0,
      max_usage_count: null,
      program_tag: "",
      organization_id: ""
    });
    setShowDialog(true);
  };

  const handleEdit = (code) => {
    setEditingCode({ 
      ...code,
      expires_at: code.expires_at ? format(new Date(code.expires_at), "yyyy-MM-dd'T'HH:mm") : "",
      organization_id: code.organization_id || "",
      program_tag: code.program_tag || "",
      max_usage_count: code.max_usage_count || null
    });
    setShowDialog(true);
  };

  const handleCopy = (code) => {
    setEditingCode({
      ...code,
      id: undefined,
      code: code.code + "_COPY",
      is_active: false,
      current_usage_count: 0,
      expires_at: code.expires_at ? format(new Date(code.expires_at), "yyyy-MM-dd'T'HH:mm") : "",
      organization_id: code.organization_id || "",
      program_tag: code.program_tag || ""
    });
    setShowDialog(true);
  };

  const handleDelete = (code) => {
    if (!canDeleteCode(code)) {
      toast.error('Cannot delete a discount code that has been used');
      return;
    }
    setCodeToDelete(code);
    setShowDeleteConfirm(true);
  };

  const handleToggleActive = async (code) => {
    try {
      await base44.entities.DiscountCode.update(code.id, {
        is_active: !code.is_active
      });
      queryClient.invalidateQueries({ queryKey: ['discount-codes'] });
      toast.success(`Discount code ${code.is_active ? 'deactivated' : 'activated'}`);
    } catch (error) {
      toast.error('Failed to update status: ' + error.message);
    }
  };

  const handleSave = () => {
    if (!editingCode.code.trim()) {
      toast.error('Code is required');
      return;
    }

    if (editingCode.value <= 0) {
      toast.error('Value must be greater than 0');
      return;
    }

    if (editingCode.type === 'percentage' && editingCode.value > 100) {
      toast.error('Percentage cannot exceed 100%');
      return;
    }

    const codeData = {
      code: editingCode.code.toUpperCase().trim(),
      type: editingCode.type,
      value: parseFloat(editingCode.value),
      description: editingCode.description || "",
      is_active: editingCode.is_active,
      expires_at: editingCode.expires_at ? new Date(editingCode.expires_at).toISOString() : null,
      min_purchase_amount: parseFloat(editingCode.min_purchase_amount) || 0,
      max_usage_count: editingCode.max_usage_count ? parseInt(editingCode.max_usage_count) : null,
      program_tag: editingCode.program_tag || null,
      organization_id: editingCode.organization_id || null
    };

    if (editingCode.id) {
      updateCodeMutation.mutate({ id: editingCode.id, codeData });
    } else {
      createCodeMutation.mutate(codeData);
    }
  };

  const getUsageInfo = (code) => {
    if (code.organization_id) {
      const usage = usageRecords.find(ur => 
        ur.discount_code_id === code.id && ur.organization_id === code.organization_id
      );
      const used = usage?.usage_count || 0;
      return {
        used,
        max: code.max_usage_count,
        hasMax: !!code.max_usage_count
      };
    } else {
      return {
        used: code.current_usage_count || 0,
        max: code.max_usage_count,
        hasMax: !!code.max_usage_count
      };
    }
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
              Discount Code Management
            </h1>
            <p className="text-slate-600">
              Create and manage discount codes for program ticket purchases
            </p>
          </div>
          <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            Create Code
          </Button>
        </div>

        {loadingCodes ? (
          <div className="text-center py-12">Loading discount codes...</div>
        ) : discountCodes.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Ticket className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Discount Codes Yet
              </h3>
              <p className="text-slate-600 mb-6">
                Create your first discount code to start offering promotions
              </p>
              <Button onClick={handleCreateNew} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Code
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-6">
            {discountCodes.map((code) => {
              const usageInfo = getUsageInfo(code);
              const org = code.organization_id ? organizations.find(o => o.id === code.organization_id) : null;
              const isExpired = code.expires_at && new Date(code.expires_at) < new Date();
              
              return (
                <Card key={code.id} className={`border-2 ${
                  !code.is_active ? 'border-slate-200 bg-slate-50' : 
                  isExpired ? 'border-red-200 bg-red-50' :
                  'border-slate-200'
                }`}>
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <Ticket className="w-5 h-5 text-blue-600" />
                          <CardTitle className="text-2xl font-bold">{code.code}</CardTitle>
                          {code.is_active ? (
                            <Badge className="bg-green-100 text-green-700">Active</Badge>
                          ) : (
                            <Badge className="bg-slate-200 text-slate-700">Draft</Badge>
                          )}
                          {isExpired && (
                            <Badge className="bg-red-100 text-red-700">Expired</Badge>
                          )}
                        </div>
                        
                        <div className="flex flex-wrap gap-2 mt-3">
                          {code.type === 'percentage' ? (
                            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                              {code.value}% OFF
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                              £{code.value.toFixed(2)} OFF
                            </Badge>
                          )}
                          
                          {code.organization_id ? (
                            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                              <Building2 className="w-3 h-3 mr-1" />
                              {org?.name || 'Organisation'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                              <Globe className="w-3 h-3 mr-1" />
                              Global
                            </Badge>
                          )}
                          
                          {code.program_tag && (
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                              {code.program_tag}
                            </Badge>
                          )}
                        </div>
                      </div>
                      
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEdit(code)}
                        >
                          <Pencil className="w-3 h-3 mr-1" />
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCopy(code)}
                        >
                          <Copy className="w-3 h-3 mr-1" />
                          Copy
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleToggleActive(code)}
                        >
                          {code.is_active ? 'Deactivate' : 'Activate'}
                        </Button>
                        {canDeleteCode(code) && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleDelete(code)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  
                  <CardContent className="pt-4">
                    <div className="grid md:grid-cols-2 gap-4">
                      <div className="space-y-3">
                        {code.description && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Description</div>
                            <p className="text-sm text-slate-700">{code.description}</p>
                          </div>
                        )}
                        
                        {code.min_purchase_amount > 0 && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Minimum Purchase</div>
                            <p className="text-sm text-slate-700">£{code.min_purchase_amount.toFixed(2)}</p>
                          </div>
                        )}
                        
                        {code.expires_at && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Expires</div>
                            <p className={`text-sm ${isExpired ? 'text-red-600 font-medium' : 'text-slate-700'}`}>
                              {format(new Date(code.expires_at), 'MMM d, yyyy h:mm a')}
                            </p>
                          </div>
                        )}
                      </div>
                      
                      <div className="space-y-3">
                        <div>
                          <div className="text-xs font-medium text-slate-500 mb-1">Usage</div>
                          {usageInfo.hasMax ? (
                            <p className="text-sm text-slate-700">
                              {usageInfo.used} / {usageInfo.max} times used
                            </p>
                          ) : (
                            <p className="text-sm text-slate-700">
                              {usageInfo.used} times used (no limit)
                            </p>
                          )}
                        </div>
                        
                        {code.created_date && (
                          <div>
                            <div className="text-xs font-medium text-slate-500 mb-1">Created</div>
                            <p className="text-sm text-slate-700">
                              {format(new Date(code.created_date), 'MMM d, yyyy')}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Edit/Create Dialog */}
        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>
                {editingCode?.id ? 'Edit Discount Code' : 'Create New Discount Code'}
              </DialogTitle>
            </DialogHeader>
            
            {editingCode && (
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="code">Code *</Label>
                    <Input
                      id="code"
                      value={editingCode.code}
                      onChange={(e) => setEditingCode({ ...editingCode, code: e.target.value.toUpperCase() })}
                      placeholder="e.g., SUMMER20"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="type">Type *</Label>
                    <Select
                      value={editingCode.type}
                      onValueChange={(value) => setEditingCode({ ...editingCode, type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">Percentage</SelectItem>
                        <SelectItem value="fixed">Fixed Amount</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="value">
                    Value * {editingCode.type === 'percentage' ? '(%)' : '(£)'}
                  </Label>
                  <Input
                    id="value"
                    type="number"
                    step="0.01"
                    min="0"
                    max={editingCode.type === 'percentage' ? "100" : undefined}
                    value={editingCode.value}
                    onChange={(e) => setEditingCode({ ...editingCode, value: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={editingCode.description}
                    onChange={(e) => setEditingCode({ ...editingCode, description: e.target.value })}
                    placeholder="Internal description for this code..."
                    rows={2}
                  />
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="organization">Organisation (Optional)</Label>
                    <Select
                      value={editingCode.organization_id}
                      onValueChange={(value) => setEditingCode({ ...editingCode, organization_id: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Global (all organisations)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={null}>Global (all organisations)</SelectItem>
                        {organizations.map(org => (
                          <SelectItem key={org.id} value={org.id}>{org.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="program">Program (Optional)</Label>
                    <Select
                      value={editingCode.program_tag}
                      onValueChange={(value) => setEditingCode({ ...editingCode, program_tag: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="All programs" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={null}>All programs</SelectItem>
                        {programs.map(prog => (
                          <SelectItem key={prog.id} value={prog.program_tag}>{prog.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="min-purchase">Minimum Purchase (£)</Label>
                    <Input
                      id="min-purchase"
                      type="number"
                      step="0.01"
                      min="0"
                      value={editingCode.min_purchase_amount}
                      onChange={(e) => setEditingCode({ ...editingCode, min_purchase_amount: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="max-usage">Max Uses (Optional)</Label>
                    <Input
                      id="max-usage"
                      type="number"
                      min="1"
                      value={editingCode.max_usage_count || ''}
                      onChange={(e) => setEditingCode({ ...editingCode, max_usage_count: e.target.value })}
                      placeholder="Unlimited"
                    />
                    <p className="text-xs text-slate-500">
                      {editingCode.organization_id ? 'Per organisation' : 'Total across all organisations'}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="expires">Expiry Date (Optional)</Label>
                  <Input
                    id="expires"
                    type="datetime-local"
                    value={editingCode.expires_at}
                    onChange={(e) => setEditingCode({ ...editingCode, expires_at: e.target.value })}
                  />
                </div>

                <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-lg">
                  <Switch
                    id="is-active"
                    checked={editingCode.is_active}
                    onCheckedChange={(checked) => setEditingCode({ ...editingCode, is_active: checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="is-active" className="cursor-pointer font-medium">
                      Active
                    </Label>
                    <p className="text-xs text-slate-500 mt-1">
                      Only active codes can be used by members
                    </p>
                  </div>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDialog(false);
                  setEditingCode(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={createCodeMutation.isPending || updateCodeMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                {editingCode?.id ? 'Update Code' : 'Create Code'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirmation Dialog */}
        <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Discount Code</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 bg-red-50 rounded-lg">
                <AlertCircle className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-900 font-medium">
                    Are you sure you want to delete "{codeToDelete?.code}"?
                  </p>
                  <p className="text-xs text-red-700 mt-1">
                    This action cannot be undone.
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setCodeToDelete(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => codeToDelete && deleteCodeMutation.mutate(codeToDelete.id)}
                disabled={deleteCodeMutation.isPending}
                className="bg-red-600 hover:bg-red-700"
              >
                Delete Code
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}