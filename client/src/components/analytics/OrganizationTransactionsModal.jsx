
import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, X, FileText, Download, Calendar, RotateCcw } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export default function OrganizationTransactionsModal({ 
  organizationId, 
  organizationName, 
  programNameFilter,
  memberInfo,
  onClose, 
  onTransactionUpdated 
}) {
  const [cancellingTransaction, setCancellingTransaction] = useState(null);
  const [reinstatingTransaction, setReinstatingTransaction] = useState(null);
  const [quantityToCancel, setQuantityToCancel] = useState("");
  
  const queryClient = useQueryClient();

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['organization-transactions', organizationId, programNameFilter],
    queryFn: async () => {
      const allTransactions = await base44.entities.ProgramTicketTransaction.list() || [];
      let filtered = allTransactions.filter(t => t.organization_id === organizationId);
      
      if (programNameFilter && programNameFilter !== 'all') {
        filtered = filtered.filter(t => t.program_name === programNameFilter);
      }
      
      // Sort by date descending
      return filtered.sort((a, b) => 
        new Date(b.created_date).getTime() - new Date(a.created_date).getTime()
      );
    },
    enabled: !!organizationId,
    staleTime: 0,
    refetchOnMount: true,
  });

  const cancelTransactionMutation = useMutation({
    mutationFn: async ({ transactionId, quantity }) => {
      const response = await base44.functions.invoke('cancelProgramTicketTransaction', {
        transactionId,
        quantityToCancel: quantity,
        adminEmail: memberInfo.email
      });
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['organization-transactions'] });
      queryClient.invalidateQueries({ queryKey: ['all-transactions'] });
      queryClient.invalidateQueries({ queryKey: ['all-organizations'] });
      setCancellingTransaction(null);
      setQuantityToCancel("");
      toast.success(data.message || 'Transaction cancelled successfully');
      if (onTransactionUpdated) {
        onTransactionUpdated();
      }
    },
    onError: (error) => {
      const errorMessage = error.response?.data?.error || error.message || 'Failed to cancel transaction';
      toast.error(errorMessage);
    }
  });

  const reinstateTransactionMutation = useMutation({
    mutationFn: async ({ transactionId }) => {
      const response = await base44.functions.invoke('reinstateProgramTicketTransaction', {
        transactionId,
        adminEmail: memberInfo.email
      });
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['organization-transactions'] });
      queryClient.invalidateQueries({ queryKey: ['all-transactions'] });
      queryClient.invalidateQueries({ queryKey: ['all-organizations'] });
      setReinstatingTransaction(null);
      toast.success(data.message || 'Transaction reinstated successfully');
      if (onTransactionUpdated) {
        onTransactionUpdated();
      }
    },
    onError: (error) => {
      const errorMessage = error.response?.data?.error || error.message || 'Failed to reinstate transaction';
      toast.error(errorMessage);
    }
  });

  const handleStartCancel = (transaction) => {
    const originalQty = transaction.original_quantity || transaction.quantity;
    const cancelledQty = transaction.cancelled_quantity || 0;
    const remaining = originalQty - cancelledQty;
    
    setCancellingTransaction(transaction);
    setQuantityToCancel(remaining.toString());
  };

  const handleConfirmCancel = () => {
    const qty = parseInt(quantityToCancel);
    
    if (isNaN(qty) || qty <= 0) {
      toast.error('Please enter a valid quantity');
      return;
    }

    const originalQty = cancellingTransaction.original_quantity || cancellingTransaction.quantity;
    const cancelledQty = cancellingTransaction.cancelled_quantity || 0;
    const remaining = originalQty - cancelledQty;

    if (qty > remaining) {
      toast.error(`Cannot cancel more than ${remaining} ticket(s)`);
      return;
    }

    cancelTransactionMutation.mutate({
      transactionId: cancellingTransaction.id,
      quantity: qty
    });
  };

  const handleStartReinstate = (transaction) => {
    setReinstatingTransaction(transaction);
  };

  const handleConfirmReinstate = () => {
    reinstateTransactionMutation.mutate({
      transactionId: reinstatingTransaction.id
    });
  };

  const handleDownloadInvoice = async (transaction) => {
    if (!transaction.xero_invoice_pdf_uri) {
      toast.error('No invoice PDF available');
      return;
    }

    try {
      const response = await base44.integrations.Core.CreateFileSignedUrl({
        file_uri: transaction.xero_invoice_pdf_uri,
        expires_in: 300
      });

      if (response.signed_url) {
        window.open(response.signed_url, '_blank');
      }
    } catch (error) {
      toast.error('Failed to download invoice');
      console.error('Invoice download error:', error);
    }
  };

  const getTransactionTypeColor = (type) => {
    switch (type) {
      case 'purchase': return 'bg-green-100 text-green-700';
      case 'usage': return 'bg-blue-100 text-blue-700';
      case 'refund': return 'bg-purple-100 text-purple-700';
      case 'cancellation_void': return 'bg-red-100 text-red-700';
      case 'reinstatement': return 'bg-emerald-100 text-emerald-700';
      default: return 'bg-slate-100 text-slate-700';
    }
  };

  const getTransactionTypeLabel = (type) => {
    switch (type) {
      case 'purchase': return 'Purchase';
      case 'usage': return 'Usage';
      case 'refund': return 'Refund';
      case 'cancellation_void': return 'Cancelled';
      case 'reinstatement': return 'Reinstated';
      default: return type;
    }
  };

  return (
    <>
      <Dialog open={true} onOpenChange={onClose}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-xl">
              Transaction History - {organizationName}
              {programNameFilter && programNameFilter !== 'all' && (
                <span className="text-slate-500 font-normal ml-2">({programNameFilter})</span>
              )}
            </DialogTitle>
          </DialogHeader>

          {isLoading ? (
            <div className="py-12 text-center text-slate-600">Loading transactions...</div>
          ) : transactions.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-slate-600">No transactions found</p>
            </div>
          ) : (
            <div className="space-y-3">
              {transactions.map((transaction) => {
                const originalQty = transaction.original_quantity || transaction.quantity || 0;
                const cancelledQty = transaction.cancelled_quantity || 0;
                const remainingQty = originalQty - cancelledQty;
                const isPurchase = transaction.transaction_type === 'purchase';
                const isActive = !transaction.status || transaction.status === 'active';
                const isCancelled = transaction.status === 'cancelled';
                const canBeCancelled = isPurchase && isActive && remainingQty > 0;
                // Can reinstate if it's a purchase AND has any cancelled tickets (fully or partially cancelled)
                const canBeReinstated = isPurchase && cancelledQty > 0;

                // Debug logging
                console.log('[OrganizationTransactionsModal] Transaction:', {
                  id: transaction.id,
                  type: transaction.transaction_type,
                  status: transaction.status,
                  originalQty,
                  cancelledQty,
                  remainingQty,
                  isPurchase,
                  isActive,
                  isCancelled,
                  canBeCancelled,
                  canBeReinstated
                });

                return (
                  <Card key={transaction.id} className="border-slate-200">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <Badge className={getTransactionTypeColor(transaction.transaction_type)}>
                              {getTransactionTypeLabel(transaction.transaction_type)}
                            </Badge>
                            {transaction.status === 'cancelled' && (
                              <Badge className="bg-red-100 text-red-700">Fully Cancelled</Badge>
                            )}
                            {isPurchase && cancelledQty > 0 && transaction.status !== 'cancelled' && (
                              <Badge className="bg-amber-100 text-amber-700">Partially Cancelled</Badge>
                            )}
                          </div>

                          <div className="grid md:grid-cols-2 gap-3 text-sm">
                            <div>
                              <span className="text-slate-600">Program:</span>
                              <span className="font-medium text-slate-900 ml-2">{transaction.program_name}</span>
                            </div>

                            {isPurchase ? (
                              <div>
                                <span className="text-slate-600">Quantity:</span>
                                <span className="font-medium text-slate-900 ml-2">
                                  {cancelledQty > 0 ? (
                                    <>
                                      <span className="text-green-600">{originalQty}</span>
                                      <span className="text-slate-400 mx-1">-</span>
                                      <span className="text-red-600">{cancelledQty}</span>
                                      <span className="text-slate-400 mx-1">=</span>
                                      <span className="text-blue-600">{remainingQty}</span>
                                    </>
                                  ) : (
                                    originalQty
                                  )}
                                </span>
                              </div>
                            ) : (
                              <div>
                                <span className="text-slate-600">Quantity:</span>
                                <span className="font-medium text-slate-900 ml-2">{transaction.quantity}</span>
                              </div>
                            )}

                            {transaction.member_email && (
                              <div>
                                <span className="text-slate-600">Member:</span>
                                <span className="font-medium text-slate-900 ml-2">{transaction.member_email}</span>
                              </div>
                            )}

                            <div className="flex items-center gap-1">
                              <Calendar className="w-3 h-3 text-slate-400" />
                              <span className="text-slate-600">{format(new Date(transaction.created_date), 'MMM d, yyyy HH:mm')}</span>
                            </div>

                            {transaction.purchase_order_number && (
                              <div>
                                <span className="text-slate-600">PO Number:</span>
                                <span className="font-medium text-slate-900 ml-2">{transaction.purchase_order_number}</span>
                              </div>
                            )}

                            {transaction.booking_reference && (
                              <div>
                                <span className="text-slate-600">Booking Ref:</span>
                                <span className="font-medium text-slate-900 ml-2">{transaction.booking_reference}</span>
                              </div>
                            )}

                            {transaction.event_name && (
                              <div>
                                <span className="text-slate-600">Event:</span>
                                <span className="font-medium text-slate-900 ml-2">{transaction.event_name}</span>
                              </div>
                            )}

                            {transaction.xero_invoice_number && (
                              <div className="flex items-center gap-2">
                                <span className="text-slate-600">Invoice:</span>
                                <span className="font-medium text-slate-900">{transaction.xero_invoice_number}</span>
                                {transaction.xero_invoice_pdf_uri && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2"
                                    onClick={() => handleDownloadInvoice(transaction)}
                                  >
                                    <Download className="w-3 h-3" />
                                  </Button>
                                )}
                              </div>
                            )}

                            {transaction.total_cost_before_discount && (
                              <div>
                                <span className="text-slate-600">Value:</span>
                                <span className="font-medium text-slate-900 ml-2">
                                  £{transaction.total_cost_before_discount.toFixed(2)}
                                </span>
                              </div>
                            )}
                          </div>

                          {transaction.notes && (
                            <div className="mt-2 text-sm text-slate-600 italic">
                              {transaction.notes}
                            </div>
                          )}
                        </div>

                        <div className="flex-shrink-0 flex gap-2">
                          {canBeCancelled && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleStartCancel(transaction)}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50 whitespace-nowrap"
                            >
                              Cancel Tickets
                            </Button>
                          )}
                          {canBeReinstated && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleStartReinstate(transaction)}
                              className="text-green-600 hover:text-green-700 hover:bg-green-50 whitespace-nowrap"
                            >
                              <RotateCcw className="w-3 h-3 mr-1" />
                              Reinstate
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancellation Confirmation Dialog */}
      {cancellingTransaction && (
        <Dialog open={true} onOpenChange={() => setCancellingTransaction(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cancel Tickets</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-amber-900 mb-1">Important:</p>
                    <p className="text-amber-800">
                      This will void the selected tickets from this purchase. The tickets will be removed from the organisation's available balance. You can reinstate them later if needed.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm">
                  <span className="text-slate-600">Original Purchase:</span>
                  <span className="font-semibold text-slate-900 ml-2">
                    {cancellingTransaction.original_quantity || cancellingTransaction.quantity} ticket(s)
                  </span>
                </div>
                {(cancellingTransaction.cancelled_quantity || 0) > 0 && (
                  <div className="text-sm">
                    <span className="text-slate-600">Already Cancelled:</span>
                    <span className="font-semibold text-red-600 ml-2">
                      {cancellingTransaction.cancelled_quantity} ticket(s)
                    </span>
                  </div>
                )}
                <div className="text-sm">
                  <span className="text-slate-600">Available to Cancel:</span>
                  <span className="font-semibold text-blue-600 ml-2">
                    {(cancellingTransaction.original_quantity || cancellingTransaction.quantity) - (cancellingTransaction.cancelled_quantity || 0)} ticket(s)
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="cancel-quantity">Quantity to Cancel *</Label>
                <Input
                  id="cancel-quantity"
                  type="number"
                  min="1"
                  max={(cancellingTransaction.original_quantity || cancellingTransaction.quantity) - (cancellingTransaction.cancelled_quantity || 0)}
                  value={quantityToCancel}
                  onChange={(e) => setQuantityToCancel(e.target.value)}
                  placeholder="Enter number of tickets to cancel"
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCancellingTransaction(null)}
                disabled={cancelTransactionMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmCancel}
                disabled={cancelTransactionMutation.isPending || !quantityToCancel}
                className="bg-red-600 hover:bg-red-700"
              >
                {cancelTransactionMutation.isPending ? 'Cancelling...' : 'Confirm Cancellation'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Reinstatement Confirmation Dialog */}
      {reinstatingTransaction && (
        <Dialog open={true} onOpenChange={() => setReinstatingTransaction(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Reinstate Cancelled Tickets</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              <div className="p-4 bg-green-50 rounded-lg border border-green-200">
                <div className="flex items-start gap-3">
                  <RotateCcw className="w-5 h-5 text-green-600 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-green-900 mb-1">Reinstate Transaction</p>
                    <p className="text-green-800">
                      This will reverse the cancellation and restore the tickets back to the organisation's available balance.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-sm">
                  <span className="text-slate-600">Program:</span>
                  <span className="font-semibold text-slate-900 ml-2">
                    {reinstatingTransaction.program_name}
                  </span>
                </div>
                <div className="text-sm">
                  <span className="text-slate-600">Tickets to Reinstate:</span>
                  <span className="font-semibold text-green-600 ml-2">
                    {reinstatingTransaction.cancelled_quantity || 0} ticket(s)
                  </span>
                </div>
                {reinstatingTransaction.purchase_order_number && (
                  <div className="text-sm">
                    <span className="text-slate-600">PO Number:</span>
                    <span className="font-semibold text-slate-900 ml-2">
                      {reinstatingTransaction.purchase_order_number}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setReinstatingTransaction(null)}
                disabled={reinstateTransactionMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConfirmReinstate}
                disabled={reinstateTransactionMutation.isPending}
                className="bg-green-600 hover:bg-green-700"
              >
                {reinstateTransactionMutation.isPending ? 'Reinstating...' : 'Confirm Reinstatement'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
