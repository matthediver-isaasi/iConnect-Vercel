import React, { useState, useEffect, useMemo } from "react";
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
import { Building2, Search, ChevronLeft, ChevronRight, Plus, Minus, Wallet, TrendingUp, TrendingDown } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const ITEMS_PER_PAGE = 15;

export default function TrainingFundManagementPage() {
  const { isAdmin, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [balanceFilter, setBalanceFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  
  const [adjustingOrg, setAdjustingOrg] = useState(null);
  const [adjustmentType, setAdjustmentType] = useState("add");
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [showAdjustDialog, setShowAdjustDialog] = useState(false);
  
  const queryClient = useQueryClient();

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

  const updateBalanceMutation = useMutation({
    mutationFn: async ({ orgId, newBalance }) => {
      return base44.entities.Organization.update(orgId, { training_fund_balance: newBalance });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setShowAdjustDialog(false);
      setAdjustingOrg(null);
      setAdjustmentAmount("");
      setAdjustmentReason("");
      toast.success('Training fund balance updated successfully');
    },
    onError: (error) => {
      toast.error('Failed to update balance: ' + error.message);
    }
  });

  const handleAdjust = (org) => {
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
      newBalance: newBalance
    });
  };

  const handleSetBalance = (org, newBalance) => {
    const balance = parseFloat(newBalance);
    if (isNaN(balance) || balance < 0) {
      toast.error('Please enter a valid balance');
      return;
    }
    
    updateBalanceMutation.mutate({
      orgId: org.id,
      newBalance: balance
    });
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
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Training Fund Management
          </h1>
          <p className="text-slate-600">
            View and adjust training fund balances for organisations
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
              
              return (
                <Card 
                  key={org.id} 
                  className="border-slate-200 shadow-sm hover:shadow-md transition-shadow"
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
                          {org.type && (
                            <p className="text-sm text-slate-500">{org.type}</p>
                          )}
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
                          onClick={() => handleAdjust(org)}
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
