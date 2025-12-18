import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';

export function useBalancesRealtime(organizationId, options = {}) {
  const {
    onVoucherUpdated = null,
    onTrainingFundUpdated = null
  } = options;

  const queryClient = useQueryClient();
  const orgIdRef = useRef(organizationId);
  const onVoucherUpdatedRef = useRef(onVoucherUpdated);
  const onTrainingFundUpdatedRef = useRef(onTrainingFundUpdated);
  const [isConnected, setIsConnected] = useState(false);
  const [lastVoucherUpdate, setLastVoucherUpdate] = useState(null);
  const [lastTrainingFundUpdate, setLastTrainingFundUpdate] = useState(null);

  orgIdRef.current = organizationId;
  onVoucherUpdatedRef.current = onVoucherUpdated;
  onTrainingFundUpdatedRef.current = onTrainingFundUpdated;

  const invalidateVoucherQueries = useCallback(() => {
    if (orgIdRef.current) {
      queryClient.invalidateQueries({ queryKey: ['vouchers', orgIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['vouchers'] });
    }
  }, [queryClient]);

  const invalidateOrganizationQueries = useCallback(() => {
    if (orgIdRef.current) {
      queryClient.invalidateQueries({ queryKey: ['organization', orgIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Organization', orgIdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['/api/entities/Organization'] });
    }
  }, [queryClient]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useBalancesRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    if (!orgIdRef.current) {
      console.log('[useBalancesRealtime] No organization ID, skipping subscription');
      return;
    }

    console.log('[useBalancesRealtime] Setting up realtime subscriptions for org:', orgIdRef.current);

    const uniqueId = Math.random().toString(36).substr(2, 9);
    
    const voucherChannel = supabase
      .channel(`voucher-changes-${orgIdRef.current}-${uniqueId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'voucher',
          filter: `organization_id=eq.${orgIdRef.current}`
        },
        (payload) => {
          const newData = payload.new;
          const oldData = payload.old;
          const eventType = payload.eventType;

          console.log('[useBalancesRealtime] Voucher change detected:', {
            eventType,
            voucherId: newData?.id || oldData?.id,
            oldValue: oldData?.value,
            newValue: newData?.value,
            status: newData?.status
          });

          setLastVoucherUpdate({
            eventType,
            voucher: newData || oldData,
            timestamp: Date.now()
          });

          invalidateVoucherQueries();

          if (onVoucherUpdatedRef.current) {
            onVoucherUpdatedRef.current({
              eventType,
              voucher: newData || oldData
            });
          }
        }
      )
      .subscribe((status) => {
        console.log('[useBalancesRealtime] Voucher subscription status:', status);
        if (status === 'SUBSCRIBED') {
          setIsConnected(true);
        }
      });

    const orgChannel = supabase
      .channel(`org-training-fund-${orgIdRef.current}-${uniqueId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'organization',
          filter: `id=eq.${orgIdRef.current}`
        },
        (payload) => {
          const newData = payload.new;
          const oldData = payload.old;

          console.log('[useBalancesRealtime] Organization update detected:', {
            orgId: newData?.id,
            oldTrainingFund: oldData?.training_fund_balance,
            newTrainingFund: newData?.training_fund_balance
          });

          if (oldData?.training_fund_balance !== newData?.training_fund_balance) {
            setLastTrainingFundUpdate({
              oldBalance: oldData?.training_fund_balance,
              newBalance: newData?.training_fund_balance,
              timestamp: Date.now()
            });

            invalidateOrganizationQueries();

            if (onTrainingFundUpdatedRef.current) {
              onTrainingFundUpdatedRef.current({
                oldBalance: oldData?.training_fund_balance,
                newBalance: newData?.training_fund_balance
              });
            }
          }
        }
      )
      .subscribe((status) => {
        console.log('[useBalancesRealtime] Organization subscription status:', status);
      });

    return () => {
      console.log('[useBalancesRealtime] Cleaning up realtime subscriptions for org:', orgIdRef.current);
      supabase.removeChannel(voucherChannel);
      supabase.removeChannel(orgChannel);
      setIsConnected(false);
    };
  }, [organizationId, invalidateVoucherQueries, invalidateOrganizationQueries]);

  return {
    isConnected,
    lastVoucherUpdate,
    lastTrainingFundUpdate,
    invalidateVoucherQueries,
    invalidateOrganizationQueries
  };
}
