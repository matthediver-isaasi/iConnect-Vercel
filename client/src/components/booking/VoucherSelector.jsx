
import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Ticket, Calendar, AlertCircle, Loader2 } from "lucide-react";
import { format } from "date-fns";

export default function VoucherSelector({ organizationId, selectedVouchers, onVoucherToggle, maxAmount }) {
  // Fetch raw vouchers without any sorting in the queryFn
  const { data: rawVouchers = [], isLoading, error } = useQuery({
    queryKey: ['vouchers', organizationId],
    queryFn: async () => {
      if (!organizationId) return [];
      
      console.log('[VoucherSelector] Fetching vouchers for org:', organizationId);
      
      // Fetch ALL vouchers, then filter in JavaScript
      const allVouchers = await base44.entities.Voucher.list();
      
      console.log('[VoucherSelector] All vouchers fetched:', allVouchers.length);
      
      // Filter for this organization, active status, and not expired - no sorting here
      const now = new Date();
      const activeVouchers = allVouchers.filter(v => 
        v.organization_id === organizationId && 
        v.status === 'active' &&
        // Exclude expired vouchers
        (!v.expires_at || new Date(v.expires_at) > now)
      );
      
      console.log('[VoucherSelector] Active vouchers for this org:', activeVouchers.length);
      
      return activeVouchers;
    },
    enabled: !!organizationId,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Apply sorting as derived state using useMemo - this runs on EVERY render
  const vouchers = useMemo(() => {
    if (!rawVouchers || rawVouchers.length === 0) return [];
    
    console.log('[VoucherSelector] BEFORE client-side sort:', rawVouchers.map(v => ({
      code: v.code,
      value: v.value,
      expires_at: v.expires_at,
      expiryTimestamp: new Date(v.expires_at).getTime()
    })));
    
    // Sort intelligently:
    // 1. Primary sort: By expiry date (soonest first)
    // 2. Secondary sort: By value (smallest first) for same expiry date
    const sortedVouchers = [...rawVouchers].sort((a, b) => {
      const dateA = new Date(a.expires_at).getTime();
      const dateB = new Date(b.expires_at).getTime();
      
      // Primary sort: by expiry date (ascending - soonest first)
      if (dateA !== dateB) {
        return dateA - dateB;
      }
      
      // Secondary sort: by value (ascending - smallest first)
      return a.value - b.value;
    });
    
    console.log('[VoucherSelector] AFTER client-side sort:', sortedVouchers.map(v => ({
      code: v.code,
      value: v.value,
      expires_at: v.expires_at,
      expiryTimestamp: new Date(v.expires_at).getTime()
    })));
    
    return sortedVouchers;
  }, [rawVouchers]); // Re-run sort whenever rawVouchers changes

  // Simulate voucher usage to determine visual states
  const voucherUsageInfo = useMemo(() => {
    const usageMap = new Map();
    
    if (!maxAmount || selectedVouchers.length === 0) {
      return usageMap;
    }

    // Get selected vouchers in the correct sorted order
    const selectedVoucherObjects = selectedVouchers
      .map(id => vouchers.find(v => v.id === id))
      .filter(v => v !== undefined)
      .sort((a, b) => {
        const dateA = new Date(a.expires_at).getTime();
        const dateB = new Date(b.expires_at).getTime();
        
        if (dateA !== dateB) {
          return dateA - dateB;
        }
        
        return a.value - b.value;
      });

    let remainingCost = maxAmount;

    for (const voucher of selectedVoucherObjects) {
      if (remainingCost <= 0) {
        break;
      }

      const amountToUse = Math.min(voucher.value, remainingCost);
      const isFullyUsed = amountToUse >= voucher.value;
      const remainingValue = voucher.value - amountToUse;

      usageMap.set(voucher.id, {
        amountUsed: amountToUse,
        isFullyUsed: isFullyUsed,
        remainingValue: remainingValue
      });

      remainingCost -= amountToUse;
    }

    return usageMap;
  }, [vouchers, selectedVouchers, maxAmount]);

  const handleToggle = (voucherId, checked) => {
    if (checked) {
      onVoucherToggle([...selectedVouchers, voucherId]);
    } else {
      onVoucherToggle(selectedVouchers.filter(id => id !== voucherId));
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 rounded-lg border border-slate-200 bg-blue-50">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>Loading vouchers...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 rounded-lg border border-red-200 bg-red-50">
        <div className="flex items-start gap-2 text-sm text-red-600">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <div>
            <p className="font-medium">Error loading vouchers</p>
            <p className="text-xs mt-1">{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!organizationId) {
    return (
      <div className="p-4 rounded-lg border border-amber-200 bg-amber-50">
        <div className="flex items-start gap-2 text-sm text-amber-600">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <span>Organisation information not available</span>
        </div>
      </div>
    );
  }

  if (vouchers.length === 0) {
    return (
      <div className="p-4 rounded-lg border border-slate-200 bg-slate-50">
        <div className="flex items-start gap-2 text-sm text-slate-600">
          <AlertCircle className="w-4 h-4 mt-0.5" />
          <span>No active vouchers available</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {vouchers.length > 0 && (
        <p className="text-xs text-slate-500">
          Sorted by expiry date - vouchers expiring soonest are listed first
        </p>
      )}

      <div className="space-y-2 max-h-64 overflow-y-auto">
        {vouchers.map((voucher) => {
          const isSelected = selectedVouchers.includes(voucher.id);
          const usageInfo = voucherUsageInfo.get(voucher.id);
          const isFullyUsed = usageInfo?.isFullyUsed || false;
          const remainingValue = usageInfo?.remainingValue || 0;
          const showRemainingValue = isSelected && !isFullyUsed && remainingValue > 0;
          
          const expiryDate = new Date(voucher.expires_at);
          const daysUntilExpiry = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
          const isExpiringSoon = daysUntilExpiry <= 30;
          
          // Determine background color based on usage
          let bgColor = 'bg-white';
          if (isSelected && isFullyUsed) {
            bgColor = 'bg-green-50';
          } else if (isSelected && showRemainingValue) {
            bgColor = 'bg-yellow-50';
          } else if (isSelected) {
            bgColor = 'bg-blue-50';
          }
          
          // Determine border color
          let borderColor = 'border-slate-200';
          if (isSelected && isFullyUsed) {
            borderColor = 'border-green-300';
          } else if (isSelected && showRemainingValue) {
            borderColor = 'border-yellow-300';
          } else if (isSelected) {
            borderColor = 'border-blue-500';
          }
          
          // Determine icon color
          let iconColor = 'text-slate-400';
          if (isSelected && isFullyUsed) {
            iconColor = 'text-green-600';
          } else if (isSelected && showRemainingValue) {
            iconColor = 'text-yellow-600';
          } else if (isSelected) {
            iconColor = 'text-blue-600';
          }
          
          return (
            <div
              key={voucher.id}
              className={`p-3 rounded-lg border transition-all ${borderColor} ${bgColor}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Ticket className={`w-4 h-4 shrink-0 ${iconColor}`} />
                    <span className="font-semibold text-slate-900 truncate">{voucher.code}</span>
                    <Badge className="bg-green-100 text-green-700 text-xs">
                      £{voucher.value.toFixed(2)}
                    </Badge>
                  </div>
                  
                  {voucher.description && (
                    <p className="text-xs text-slate-600 mb-2">{voucher.description}</p>
                  )}
                  
                  <div className="flex items-center gap-1 text-xs">
                    <Calendar className="w-3 h-3 text-slate-400" />
                    <span className={isExpiringSoon ? 'text-amber-600 font-medium' : 'text-slate-500'}>
                      Expires {format(expiryDate, 'MMM d, yyyy')}
                      {isExpiringSoon && ` (${daysUntilExpiry} days)`}
                    </span>
                  </div>
                  
                  {showRemainingValue && (
                    <div className="mt-2 pt-2 border-t border-yellow-200">
                      <p className="text-xs text-yellow-700 font-medium">
                        Remaining balance after purchase: £{remainingValue.toFixed(2)}
                      </p>
                    </div>
                  )}
                </div>
                
                <Switch
                  checked={isSelected}
                  onCheckedChange={(checked) => handleToggle(voucher.id, checked)}
                  className="shrink-0"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
