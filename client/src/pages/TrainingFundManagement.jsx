import React, { useState, useEffect, useMemo, useCallback } from "react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Building2, Search, ChevronLeft, ChevronRight, Plus, Minus, Wallet, TrendingUp, TrendingDown, History, ArrowLeft, X, Wifi } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useAdminBalancesRealtime } from "@/hooks/useAdminBalancesRealtime";

const ITEMS_PER_PAGE = 15;

export default function TrainingFundManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady, memberInfo } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [balanceFilter, setBalanceFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  
  const [adjustingOrg, setAdjustingOrg] = useState(null);
  const [adjustmentType, setAdjustmentType] = useState("add");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [showAdjustDialog, setShowAdjustDialog] = useState(false);
  
  const [selectedOrg, setSelectedOrg] = useState(null);
  
  const queryClient = useQueryClient();

  // Realtime callbacks for admin updates
  const handleTransactionUpdated = useCallback(({ eventType, transaction }) => {
    console.log('[TrainingFundManagement] Transaction updated via realtime:', eventType, transaction?.id);
    if (eventType === 'INSERT') {
      toast.info('New transaction recorded', {
        description: 'A training fund transaction was just created.',
        duration: 3000
      });
    }
  }, []);

  const handleOrganizationUpdated = useCallback(({ organization, oldBalance, newBalance }) => {
    console.log('[TrainingFundManagement] Organization updated via realtime:', organization?.id);
    toast.info('Training fund balance updated', {
      description: `${organization?.name}: £${(oldBalance || 0).toFixed(2)} → £${(newBalance || 0).toFixed(2)}`,
      duration: 3000
    });
  }, []);

  // Subscribe to realtime updates
  const { isConnected: realtimeConnected } = useAdminBalancesRealtime({
    onTrainingFundTransactionUpdated: handleTransactionUpdated,
    onOrganizationUpdated: handleOrganizationUpdated
  });

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin || isFeatureExcluded('page_TrainingFundManagement')) {
        window.location.href = createPageUrl('Dashboard');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady, isFeatureExcluded]);

  const { data: organizations = [], isLoading: loadingOrgs } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: allTransactions = [], isLoading: loadingTransactions } = useQuery({
    queryKey: ['training-fund-transactions'],
    queryFn: () => base44.entities.TrainingFundTransaction.list('-created_date'),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: members = [] } = useQuery({
    queryKey: ['members-for-transactions'],
    queryFn: () => base44.entities.Member.list(),
    staleTime: 60000,
  });

  const memberMap = useMemo(() => {
    const map = {};
    members.forEach(m => { map[m.id] = m; });
    return map;
  }, [members]);

  const selectedOrgTransactions = useMemo(() => {
    if (!selectedOrg) return [];
    return allTransactions.filter(t => t.organization_id === selectedOrg.id);
  }, [allTransactions, selectedOrg]);

  const filteredOrgs = useMemo(() => {
    let filtered = organizations;
    
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(org => 
        org.name?.toLowerCase().includes(term)
      );
    }
    
    if (balanceFilter === "with_balance") {
      filtered = filtered.filter(org => (org.training_fund_balance || 0) > 0);
    } else if (balanceFilter === "zero_balance") {
      filtered = filtered.filter(org => (org.training_fund_balance || 0) === 0);
    }
    
    return filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [organizations, searchTerm, balanceFilter]);

  const totalPages = Math.ceil(filteredOrgs.length / ITEMS_PER_PAGE);
  const paginatedOrgs = useMemo(() => {
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredOrgs.slice(start, start + ITEMS_PER_PAGE);
  }, [filteredOrgs, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, balanceFilter]);

  const totalFunds = useMemo(() => {
    return organizations.reduce((sum, org) => sum + (org.training_fund_balance || 0), 0);
  }, [organizations]);

  const orgsWithFunds = useMemo(() => {
    return organizations.filter(org => (org.training_fund_balance || 0) > 0).length;
  }, [organizations]);

  const createTransactionMutation = useMutation({
    mutationFn: (transactionData) => base44.entities.TrainingFundTransaction.create(transactionData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['training-fund-transactions'] });
    }
  });

  const updateBalanceMutation = useMutation({
    mutationFn: async ({ orgId, newBalance, balanceBefore, type, reason }) => {
      console.log('[TrainingFund] Starting balance update:', { orgId, newBalance, balanceBefore, type, reason });
      
      try {
        console.log('[TrainingFund] Updating organization balance...');
        await base44.entities.Organization.update(orgId, { training_fund_balance: newBalance });
        console.log('[TrainingFund] Organization balance updated successfully');
        
        console.log('[TrainingFund] Creating transaction record...');
        await createTransactionMutation.mutateAsync({
          organization_id: orgId,
          type: type,
          amount: Math.abs(newBalance - balanceBefore),
          balance_before: balanceBefore,
          balance_after: newBalance,
          reason: reason || (type === 'add' ? 'Funds added' : 'Funds deducted'),
          created_by: memberInfo?.id || null,
          created_date: new Date().toISOString()
        });
        console.log('[TrainingFund] Transaction record created successfully');
        
        return { orgId, newBalance };
      } catch (innerError) {
        console.error('[TrainingFund] Error in mutationFn:', innerError);
        throw innerError;
      }
    },
    onSuccess: () => {
      console.log('[TrainingFund] Mutation success - invalidating queries');
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setShowAdjustDialog(false);
      setAdjustingOrg(null);
      setAdjustmentAmount("");
      setAdjustmentReason("");
      toast.success('Training fund balance updated successfully');
    },
    onError: (error) => {
      console.error('[TrainingFund] Mutation error:', error);
      toast.error('Failed to update balance: ' + error.message);
    }
  });

  const handleAdjust = (org, e) => {
    if (e) e.stopPropagation();
    setAdjustingOrg(org);
    setAdjustmentType("add");
    setAdjustmentAmount("");
    setAdjustmentReason("");
    setShowAdjustDialog(true);
  };

  const handleSaveAdjustment = () => {
    const amount = parseFloat(adjustmentAmount);
    if (isNaN(amount) || amount <= 0) {
      toast.error('Please enter a valid amount greater than 0');
      return;
    }

    const currentBalance = adjustingOrg.training_fund_balance || 0;
    let newBalance;
    
    if (adjustmentType === "add") {
      newBalance = currentBalance + amount;
    } else {
      newBalance = currentBalance - amount;
      if (newBalance < 0) {
        toast.error('Cannot reduce balance below zero');
        return;
      }
    }

    updateBalanceMutation.mutate({
      orgId: adjustingOrg.id,
      newBalance: newBalance,
      balanceBefore: currentBalance,
      type: adjustmentType,
      reason: adjustmentReason
    });
  };

  const handleOrgClick = (org) => {
    setSelectedOrg(org);
  };

  const handleBackToList = () => {
    setSelectedOrg(null);
  };

  const formatTransactionType = (type) => {
    switch (type) {
      case 'add': return { label: 'Added', color: 'bg-green-100 text-green-800' };
      case 'deduct': return { label: 'Deducted', color: 'bg-red-100 text-red-800' };
      case 'booking_usage': return { label: 'Booking', color: 'bg-blue-100 text-blue-800' };
      default: return { label: type, color: 'bg-slate-100 text-slate-800' };
    }
  };

  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  if (selectedOrg) {
    const orgBalance = selectedOrg.training_fund_balance || 0;
    
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="mb-6">
            <Button 
              variant="ghost" 
              onClick={handleBackToList}
              className="mb-4"
              data-testid="button-back-to-list"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Organisations
            </Button>
            
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-slate-900 mb-1">
                  {selectedOrg.name}
                </h1>
                <p className="text-slate-600">Training Fund History</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-500">Current Balance</p>
                <p className={`text-3xl font-bold ${orgBalance > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                  £{orgBalance.toFixed(2)}
                </p>
              </div>
            </div>
          </div>

          <Card className="border-slate-200 shadow-sm mb-6">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="w-5 h-5 text-slate-500" />
                  <span className="font-medium text-slate-700">
                    {selectedOrgTransactions.length} {selectedOrgTransactions.length === 1 ? 'transaction' : 'transactions'}
                  </span>
                </div>
                <Button
                  onClick={() => handleAdjust(selectedOrg)}
                  data-testid="button-adjust-from-history"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Adjust Balance
                </Button>
              </div>
            </CardContent>
          </Card>

          {loadingTransactions ? (
            <div className="text-center py-12">Loading transaction history...</div>
          ) : selectedOrgTransactions.length === 0 ? (
            <Card className="border-slate-200 shadow-sm">
              <CardContent className="p-12 text-center">
                <History className="w-16 h-16 text-slate-300 mx-auto mb-4" />
                <h3 className="text-xl font-semibold text-slate-900 mb-2">
                  No Transaction History
                </h3>
                <p className="text-slate-600 mb-4">
                  No adjustments have been made to this organisation's training fund yet
                </p>
                <Button onClick={() => handleAdjust(selectedOrg)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Make First Adjustment
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {selectedOrgTransactions.map((transaction) => {
                const typeInfo = formatTransactionType(transaction.type);
                const createdBy = transaction.created_by ? memberMap[transaction.created_by] : null;
                
                return (
                  <Card 
                    key={transaction.id} 
                    className="border-slate-200 shadow-sm"
                    data-testid={`card-transaction-${transaction.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <Badge className={typeInfo.color}>
                              {transaction.type === 'add' && <Plus className="w-3 h-3 mr-1" />}
                              {transaction.type === 'deduct' && <Minus className="w-3 h-3 mr-1" />}
                              {typeInfo.label}
                            </Badge>
                            <span className="text-sm text-slate-500">
                              {transaction.created_date ? format(new Date(transaction.created_date), 'dd MMM yyyy, HH:mm') : 'Unknown date'}
                            </span>
                          </div>
                          
                          {transaction.reason && (
                            <p className="text-slate-700 mb-2">{transaction.reason}</p>
                          )}
                          
                          <div className="flex items-center gap-4 text-sm text-slate-500">
                            <span>
                              Before: <span className="font-medium text-slate-700">£{(transaction.balance_before || 0).toFixed(2)}</span>
                            </span>
                            <span>→</span>
                            <span>
                              After: <span className="font-medium text-slate-700">£{(transaction.balance_after || 0).toFixed(2)}</span>
                            </span>
                          </div>
                          
                          {createdBy && (
                            <p className="text-xs text-slate-400 mt-2">
                              By: {createdBy.full_name || createdBy.email}
                            </p>
                          )}
                        </div>
                        
                        <div className="text-right flex-shrink-0">
                          <p className={`text-xl font-bold ${transaction.type === 'add' ? 'text-green-600' : 'text-red-600'}`}>
                            {transaction.type === 'add' ? '+' : '-'}£{(transaction.amount || 0).toFixed(2)}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Dialog for selectedOrg view */}
        <Dialog open={showAdjustDialog} onOpenChange={setShowAdjustDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Adjust Training Fund Balance</DialogTitle>
            </DialogHeader>
            
            {adjustingOrg && (
              <div className="space-y-4">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Building2 className="w-4 h-4 text-slate-500" />
                    <span className="font-medium text-slate-900">{adjustingOrg.name}</span>
                  </div>
                  <p className="text-sm text-slate-500">
                    Current Balance: <span className="font-semibold text-slate-900">£{(adjustingOrg.training_fund_balance || 0).toFixed(2)}</span>
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Adjustment Type</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={adjustmentType === "add" ? "default" : "outline"}
                      className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : ""}
                      onClick={() => setAdjustmentType("add")}
                      data-testid="button-add-funds-history"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Funds
                    </Button>
                    <Button
                      type="button"
                      variant={adjustmentType === "deduct" ? "default" : "outline"}
                      className={adjustmentType === "deduct" ? "bg-red-600 hover:bg-red-700" : ""}
                      onClick={() => setAdjustmentType("deduct")}
                      data-testid="button-deduct-funds-history"
                    >
                      <Minus className="w-4 h-4 mr-1" />
                      Deduct Funds
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="amount-history">Amount (£) *</Label>
                  <Input
                    id="amount-history"
                    type="number"
                    step="0.01"
                    min="0"
                    value={adjustmentAmount}
                    onChange={(e) => setAdjustmentAmount(e.target.value)}
                    placeholder="0.00"
                    data-testid="input-adjustment-amount-history"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reason-history">Reason (optional)</Label>
                  <Textarea
                    id="reason-history"
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    placeholder="Reason for adjustment..."
                    rows={2}
                    data-testid="input-adjustment-reason-history"
                  />
                </div>

                {adjustmentAmount && !isNaN(parseFloat(adjustmentAmount)) && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-800">
                      New Balance: <span className="font-bold">
                        £{(
                          (adjustingOrg.training_fund_balance || 0) + 
                          (adjustmentType === "add" ? 1 : -1) * parseFloat(adjustmentAmount || 0)
                        ).toFixed(2)}
                      </span>
                    </p>
                  </div>
                )}
              </div>
            )}
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdjustDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSaveAdjustment} 
                disabled={updateBalanceMutation.isPending}
                className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}
                data-testid="button-save-adjustment-history"
              >
                {updateBalanceMutation.isPending ? 'Saving...' : 
                  adjustmentType === "add" ? 'Add Funds' : 'Deduct Funds'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Training Fund Management
            </h1>
            {realtimeConnected && (
              <div className="flex items-center gap-1.5 text-xs text-green-600" title="Live updates enabled">
                <Wifi className="w-3 h-3" />
                <span>Live</span>
              </div>
            )}
          </div>
          <p className="text-slate-600">
            View and adjust training fund balances for organisations. Click on an organisation to view its adjustment history.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-4 mb-6">
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Wallet className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Total Funds</p>
                  <p className="text-2xl font-bold text-slate-900">£{totalFunds.toFixed(2)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Orgs with Funds</p>
                  <p className="text-2xl font-bold text-slate-900">{orgsWithFunds}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-slate-500">Total Organisations</p>
                  <p className="text-2xl font-bold text-slate-900">{organizations.length}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
              <div className="relative flex-1 max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by organisation name..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="input-search-orgs"
                />
              </div>
              <div className="flex items-center gap-3">
                <Select value={balanceFilter} onValueChange={setBalanceFilter}>
                  <SelectTrigger className="w-[180px]" data-testid="select-balance-filter">
                    <SelectValue placeholder="Balance filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Organisations</SelectItem>
                    <SelectItem value="with_balance">With Balance</SelectItem>
                    <SelectItem value="zero_balance">Zero Balance</SelectItem>
                  </SelectContent>
                </Select>
                <div className="text-sm text-slate-500">
                  {filteredOrgs.length} {filteredOrgs.length === 1 ? 'organisation' : 'organisations'}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {loadingOrgs ? (
          <div className="text-center py-12">Loading organisations...</div>
        ) : filteredOrgs.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Search className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Matching Organisations
              </h3>
              <p className="text-slate-600 mb-4">
                No organisations match your search criteria
              </p>
              <Button 
                variant="outline" 
                onClick={() => { setSearchTerm(""); setBalanceFilter("all"); }}
              >
                Clear Filters
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {paginatedOrgs.map((org) => {
              const balance = org.training_fund_balance || 0;
              const orgTransactionCount = allTransactions.filter(t => t.organization_id === org.id).length;
              
              return (
                <Card 
                  key={org.id} 
                  className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => handleOrgClick(org)}
                  data-testid={`card-org-${org.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="p-2 bg-slate-100 rounded-lg flex-shrink-0">
                          <Building2 className="w-5 h-5 text-slate-600" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-semibold text-slate-900 truncate">{org.name}</h3>
                          <div className="flex items-center gap-2 text-sm text-slate-500">
                            {org.type && <span>{org.type}</span>}
                            {orgTransactionCount > 0 && (
                              <span className="flex items-center gap-1">
                                <History className="w-3 h-3" />
                                {orgTransactionCount} {orgTransactionCount === 1 ? 'transaction' : 'transactions'}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className="text-sm text-slate-500">Balance</p>
                          <p className={`text-xl font-bold ${balance > 0 ? 'text-green-600' : 'text-slate-400'}`}>
                            £{balance.toFixed(2)}
                          </p>
                        </div>
                        
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(e) => handleAdjust(org, e)}
                          data-testid={`button-adjust-${org.id}`}
                        >
                          Adjust
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-200">
                <div className="text-sm text-slate-500">
                  Showing {((currentPage - 1) * ITEMS_PER_PAGE) + 1} - {Math.min(currentPage * ITEMS_PER_PAGE, filteredOrgs.length)} of {filteredOrgs.length}
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

        <Dialog open={showAdjustDialog} onOpenChange={setShowAdjustDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Adjust Training Fund Balance</DialogTitle>
            </DialogHeader>
            
            {adjustingOrg && (
              <div className="space-y-4">
                <div className="p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Building2 className="w-4 h-4 text-slate-500" />
                    <span className="font-medium text-slate-900">{adjustingOrg.name}</span>
                  </div>
                  <p className="text-sm text-slate-500">
                    Current Balance: <span className="font-semibold text-slate-900">£{(adjustingOrg.training_fund_balance || 0).toFixed(2)}</span>
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Adjustment Type</Label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={adjustmentType === "add" ? "default" : "outline"}
                      className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : ""}
                      onClick={() => setAdjustmentType("add")}
                      data-testid="button-add-funds"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Add Funds
                    </Button>
                    <Button
                      type="button"
                      variant={adjustmentType === "deduct" ? "default" : "outline"}
                      className={adjustmentType === "deduct" ? "bg-red-600 hover:bg-red-700" : ""}
                      onClick={() => setAdjustmentType("deduct")}
                      data-testid="button-deduct-funds"
                    >
                      <Minus className="w-4 h-4 mr-1" />
                      Deduct Funds
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="amount">Amount (£) *</Label>
                  <Input
                    id="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={adjustmentAmount}
                    onChange={(e) => setAdjustmentAmount(e.target.value)}
                    placeholder="0.00"
                    data-testid="input-adjustment-amount"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="reason">Reason (optional)</Label>
                  <Textarea
                    id="reason"
                    value={adjustmentReason}
                    onChange={(e) => setAdjustmentReason(e.target.value)}
                    placeholder="Reason for adjustment..."
                    rows={2}
                    data-testid="input-adjustment-reason"
                  />
                </div>

                {adjustmentAmount && !isNaN(parseFloat(adjustmentAmount)) && (
                  <div className="p-3 bg-blue-50 rounded-lg">
                    <p className="text-sm text-blue-800">
                      New Balance: <span className="font-bold">
                        £{(
                          (adjustingOrg.training_fund_balance || 0) + 
                          (adjustmentType === "add" ? 1 : -1) * parseFloat(adjustmentAmount || 0)
                        ).toFixed(2)}
                      </span>
                    </p>
                  </div>
                )}
              </div>
            )}
            
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAdjustDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSaveAdjustment} 
                disabled={updateBalanceMutation.isPending}
                className={adjustmentType === "add" ? "bg-green-600 hover:bg-green-700" : "bg-red-600 hover:bg-red-700"}
                data-testid="button-save-adjustment"
              >
                {updateBalanceMutation.isPending ? 'Saving...' : 
                  adjustmentType === "add" ? 'Add Funds' : 'Deduct Funds'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
