import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '../api/base44Client';
import { useMemberAccess } from './useMemberAccess';

export function usePendingPurchaseOrders() {
  const queryClient = useQueryClient();
  const { memberInfo } = useMemberAccess();
  
  console.log('[usePendingPurchaseOrders] memberInfo:', memberInfo ? { id: memberInfo.id, email: memberInfo.email } : null);

  const { data: pendingPOBookings = [], isLoading, refetch } = useQuery({
    queryKey: ['pending-po-bookings', memberInfo?.id],
    queryFn: async () => {
      console.log('[usePendingPurchaseOrders] Query running, memberInfo.id:', memberInfo?.id);
      if (!memberInfo?.id) {
        console.log('[usePendingPurchaseOrders] No member ID, returning empty');
        return [];
      }
      
      try {
        const myBookings = await base44.entities.Booking.filter({ member_id: memberInfo.id });
        console.log('[usePendingPurchaseOrders] Fetched bookings count:', myBookings.length);
        
        const pendingBookings = myBookings.filter(booking => 
          booking.po_to_follow === true && 
          (!booking.purchase_order_number || booking.purchase_order_number.trim() === '')
        );
        
        console.log('[usePendingPurchaseOrders] Pending PO bookings:', pendingBookings.length);
        return pendingBookings;
      } catch (error) {
        console.error('[usePendingPurchaseOrders] Error fetching bookings:', error);
        return [];
      }
    },
    enabled: !!memberInfo?.id,
    staleTime: 30000,
    refetchOnMount: true,
  });

  const hasPendingPOs = pendingPOBookings.length > 0;
  const pendingPOCount = pendingPOBookings.length;
  
  console.log('[usePendingPurchaseOrders] hasPendingPOs:', hasPendingPOs, 'count:', pendingPOCount, 'isLoading:', isLoading);

  const invalidatePendingPOs = () => {
    queryClient.invalidateQueries({ queryKey: ['pending-po-bookings'] });
    queryClient.invalidateQueries({ queryKey: ['my-bookings'] });
  };

  return {
    pendingPOBookings,
    hasPendingPOs,
    pendingPOCount,
    isLoading,
    refetch,
    invalidatePendingPOs,
  };
}
