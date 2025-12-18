import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, isSupabaseConfigured } from '@/api/supabaseClient';

export function useAdminBalancesRealtime(options = {}) {
  const {
    onVoucherUpdated = null,
    onTrainingFundTransactionUpdated = null,
    onOrganizationUpdated = null
  } = options;

  const queryClient = useQueryClient();
  const onVoucherUpdatedRef = useRef(onVoucherUpdated);
  const onTrainingFundTransactionUpdatedRef = useRef(onTrainingFundTransactionUpdated);
  const onOrganizationUpdatedRef = useRef(onOrganizationUpdated);
  const [isConnected, setIsConnected] = useState(false);

  onVoucherUpdatedRef.current = onVoucherUpdated;
  onTrainingFundTransactionUpdatedRef.current = onTrainingFundTransactionUpdated;
  onOrganizationUpdatedRef.current = onOrganizationUpdated;

  const invalidateVoucherQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['vouchers-admin'] });
    queryClient.invalidateQueries({ queryKey: ['vouchers'] });
  }, [queryClient]);

  const invalidateTransactionQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['training-fund-transactions'] });
  }, [queryClient]);

  const invalidateOrganizationQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['organizations'] });
  }, [queryClient]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      console.log('[useAdminBalancesRealtime] Supabase not configured, skipping realtime subscription');
      return;
    }

    console.log('[useAdminBalancesRealtime] Setting up admin realtime subscriptions');

    const uniqueId = Math.random().toString(36).substr(2, 9);
    
    const voucherChannel = supabase
      .channel(`admin-voucher-changes-${uniqueId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'voucher'
        },
        (payload) => {
          const newData = payload.new;
          const oldData = payload.old;
          const eventType = payload.eventType;

          console.log('[useAdminBalancesRealtime] Voucher change detected:', {
            eventType,
            voucherId: newData?.id || oldData?.id
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
        console.log('[useAdminBalancesRealtime] Voucher subscription status:', status);
        if (status === 'SUBSCRIBED') {
          setIsConnected(true);
        }
      });

    const transactionChannel = supabase
      .channel(`admin-training-fund-tx-${uniqueId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'training_fund_transaction'
        },
        (payload) => {
          const newData = payload.new;
          const oldData = payload.old;
          const eventType = payload.eventType;

          console.log('[useAdminBalancesRealtime] Training fund transaction change detected:', {
            eventType,
            transactionId: newData?.id || oldData?.id
          });

          invalidateTransactionQueries();

          if (onTrainingFundTransactionUpdatedRef.current) {
            onTrainingFundTransactionUpdatedRef.current({
              eventType,
              transaction: newData || oldData
            });
          }
        }
      )
      .subscribe((status) => {
        console.log('[useAdminBalancesRealtime] Transaction subscription status:', status);
      });

    const orgChannel = supabase
      .channel(`admin-org-changes-${uniqueId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'organization'
        },
        (payload) => {
          const newData = payload.new;
          const oldData = payload.old;

          if (oldData?.training_fund_balance !== newData?.training_fund_balance) {
            console.log('[useAdminBalancesRealtime] Organization training fund change detected:', {
              orgId: newData?.id,
              oldBalance: oldData?.training_fund_balance,
              newBalance: newData?.training_fund_balance
            });

            invalidateOrganizationQueries();

            if (onOrganizationUpdatedRef.current) {
              onOrganizationUpdatedRef.current({
                organization: newData,
                oldBalance: oldData?.training_fund_balance,
                newBalance: newData?.training_fund_balance
              });
            }
          }
        }
      )
      .subscribe((status) => {
        console.log('[useAdminBalancesRealtime] Organization subscription status:', status);
      });

    return () => {
      console.log('[useAdminBalancesRealtime] Cleaning up admin realtime subscriptions');
      supabase.removeChannel(voucherChannel);
      supabase.removeChannel(transactionChannel);
      supabase.removeChannel(orgChannel);
      setIsConnected(false);
    };
  }, [invalidateVoucherQueries, invalidateTransactionQueries, invalidateOrganizationQueries]);

  return {
    isConnected,
    invalidateVoucherQueries,
    invalidateTransactionQueries,
    invalidateOrganizationQueries
  };
}
