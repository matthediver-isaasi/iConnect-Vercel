
import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ticket, ShoppingCart, Calendar, ArrowUpCircle, ArrowDownCircle, FileText, Download, X, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { format } from "date-fns";
import { toast } from "sonner";
import PageTour from "../components/tour/PageTour";
import TourButton from "../components/tour/TourButton";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function HistoryPage({ hasBanner }) {
  const { memberInfo, organizationInfo, memberRole, isFeatureExcluded, reloadMemberInfo, refreshOrganizationInfo } = useMemberAccess();
  const [selectedProgram, setSelectedProgram] = useState(null);
  const [downloadingInvoice, setDownloadingInvoice] = useState(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [currentInvoiceUrl, setCurrentInvoiceUrl] = useState(null);
  const [currentInvoiceNumber, setCurrentInvoiceNumber] = useState(null);
  const [showTour, setShowTour] = useState(false);
  const [tourAutoShow, setTourAutoShow] = useState(false);

  // Determine if tours should be shown for this user
  const shouldShowTours = memberRole?.show_tours !== false;

  // Check if user has seen this page's tour
  const hasSeenTour = memberInfo?.page_tours_seen?.History === true;

  // Auto-show tour on first visit if tours are enabled
  useEffect(() => {
    if (shouldShowTours && !hasSeenTour && memberInfo) {
      setTourAutoShow(true);
      setShowTour(true);
    }
  }, [shouldShowTours, hasSeenTour, memberInfo]);

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['program-transactions', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      const allTransactions = await base44.entities.ProgramTicketTransaction.list('-created_date');
      return allTransactions.filter((t) => t.organization_id === organizationInfo.id);
    },
    enabled: !!organizationInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  if (!memberInfo || !organizationInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>);

  }

  const balances = organizationInfo.program_ticket_balances || {};
  const programs = Object.keys(balances).sort();

  // If a program is selected, filter transactions for that program
  const displayTransactions = selectedProgram ?
  transactions.filter((t) => t.program_name === selectedProgram) :
  transactions;

  const updateMemberTourStatus = async (tourKey) => {
    if (memberInfo && !memberInfo.is_team_member) {
      try {
        const allMembers = await base44.entities.Member.listAll();
        const currentMember = allMembers.find((m) => m.email === memberInfo.email);

        if (currentMember) {
          const updatedTours = { ...(currentMember.page_tours_seen || {}), [tourKey]: true };
          await base44.entities.Member.update(currentMember.id, {
            page_tours_seen: updatedTours
          });

          const updatedMemberInfo = { ...memberInfo, page_tours_seen: updatedTours };
          sessionStorage.setItem('agcas_member', JSON.stringify(updatedMemberInfo));
          
          // Notify Layout to reload memberInfo
          if (reloadMemberInfo) {
            reloadMemberInfo();
          }
        }
      } catch (error) {
        console.error('Failed to update tour status:', error);
      }
    }
  };

  const handleTourComplete = async () => {
    setShowTour(false);
    setTourAutoShow(false);
  };

  const handleTourDismiss = async () => {
    setShowTour(false);
    setTourAutoShow(false);
    await updateMemberTourStatus('History');
  };

  const handleStartTour = () => {
    setShowTour(false);
    setTourAutoShow(false);

    setTimeout(() => {
      setShowTour(true);
      setTourAutoShow(true);
    }, 10);
  };

  const handleViewInvoice = async (transaction) => {
    if (!transaction.xero_invoice_pdf_uri) {
      toast.error('Invoice not available');
      return;
    }

    setDownloadingInvoice(transaction.id);

    try {
      // Get signed URL from Base44
      const response = await base44.integrations.Core.CreateFileSignedUrl({
        file_uri: transaction.xero_invoice_pdf_uri,
        expires_in: 300
      });

      if (response.signed_url) {
        // Fetch the PDF as a blob with explicit type
        const pdfResponse = await fetch(response.signed_url);
        const arrayBuffer = await pdfResponse.arrayBuffer();

        // Create a blob with explicit PDF MIME type
        const pdfBlob = new Blob([arrayBuffer], { type: 'application/pdf' });

        // Create a blob URL for inline viewing
        const blobUrl = URL.createObjectURL(pdfBlob);

        // Add parameters to hide navigation panes and fit to page
        const pdfUrl = `${blobUrl}#view=Fit&navpanes=0&toolbar=0`;

        setCurrentInvoiceUrl(pdfUrl);
        setCurrentInvoiceNumber(transaction.xero_invoice_number);
        setInvoiceModalOpen(true);
      } else {
        toast.error('Failed to generate invoice link');
      }
    } catch (error) {
      console.error('Error loading invoice:', error);
      toast.error('Failed to load invoice');
    } finally {
      setDownloadingInvoice(null);
    }
  };

  const handleDownloadInvoice = () => {
    if (!currentInvoiceUrl) return;

    const link = document.createElement('a');
    link.href = currentInvoiceUrl;
    link.download = `invoice-${currentInvoiceNumber || 'download'}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Downloading invoice...');
  };

  // Cleanup blob URL when modal closes
  const handleModalClose = (open) => {
    if (!open && currentInvoiceUrl) {
      // Remove any URL parameters before revoking
      const baseBlobUrl = currentInvoiceUrl.split('#')[0];
      URL.revokeObjectURL(baseBlobUrl);
      setCurrentInvoiceUrl(null);
      setCurrentInvoiceNumber(null);
    }
    setInvoiceModalOpen(open);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      {showTour && shouldShowTours &&
      <PageTour
        tourGroupName="History"
        viewId={null}
        onComplete={handleTourComplete}
        onDismissPermanently={handleTourDismiss}
        autoShow={tourAutoShow} />

      }

      <div className="max-w-7xl mx-auto">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-3xl md:text-4xl font-bold text-slate-900" id="history-page-title">
                History
              </h1>
              {shouldShowTours &&
              <TourButton onClick={handleStartTour} />
              }
            </div>
            <p className="text-slate-600">View your organisation's program ticket balances and transaction history
            </p>
          </div>
        )}

        {/* Program Balance Cards */}
        {programs.length > 0 ?
        <>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8" id="program-balance-cards">
              {programs.map((program) =>
            <button
              key={program}
              onClick={() => setSelectedProgram(selectedProgram === program ? null : program)}
              className="text-left">

                  <Card className={`border-2 transition-all hover:shadow-lg cursor-pointer ${
              selectedProgram === program ?
              'border-purple-600 bg-purple-50' :
              'border-slate-200 hover:border-slate-300'}`
              }>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                          <Ticket className={`w-5 h-5 ${
                      selectedProgram === program ? 'text-purple-600' : 'text-slate-400'}`
                      } />
                          <CardTitle className="text-lg">{program}</CardTitle>
                        </div>
                        {selectedProgram === program &&
                    <Badge className="bg-purple-600">Selected</Badge>
                    }
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-baseline gap-2">
                        <span className="text-3xl font-bold text-purple-600">
                          {balances[program]}
                        </span>
                        <span className="text-slate-600">tickets</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-2">
                        Click to view transactions
                      </p>
                    </CardContent>
                  </Card>
                </button>
            )}
            </div>

            {/* Transaction History */}
            <Card className="border-slate-200 shadow-sm" id="transaction-history-card">
              <CardHeader className="border-b border-slate-200">
                <CardTitle className="flex items-center gap-2">
                  {selectedProgram ?
                <>
                      Transaction History: {selectedProgram}
                      <button
                    onClick={() => setSelectedProgram(null)}
                    className="ml-auto text-sm text-blue-600 hover:text-blue-700">

                        View All
                      </button>
                    </> :

                'All Transactions'
                }
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {isLoading ?
              <div className="text-center py-8 text-slate-600">Loading transactions...</div> :
              displayTransactions.length === 0 ?
              <div className="text-center py-8">
                    <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                    <p className="text-slate-600">No transactions yet</p>
                  </div> :

              <div className="space-y-3">
                    {displayTransactions.map((transaction) => {
                  // Determine icon and color based on transaction type
                  let icon, colorClass, label;
                  if (transaction.transaction_type === 'purchase') {
                    icon = ShoppingCart;
                    colorClass = 'bg-green-100 text-green-600';
                    label = 'Purchase';
                  } else if (transaction.transaction_type === 'refund') {
                    icon = ArrowUpCircle;
                    colorClass = 'bg-blue-100 text-blue-600';
                    label = 'Return to balance';
                  } else {// 'usage'
                    icon = Calendar;
                    colorClass = 'bg-purple-100 text-purple-600';
                    label = 'Used for Event';
                  }

                  const Icon = icon;

                  return (
                    <div
                      key={transaction.id}
                      className="flex items-center gap-4 p-4 bg-slate-50 rounded-lg border border-slate-200">

                          <div className={`p-3 rounded-lg ${colorClass}`}>
                            <Icon className="w-5 h-5" />
                          </div>
                          
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold text-slate-900">{label}</h3>
                              <Badge variant="outline" className="text-xs">
                                {transaction.program_name}
                              </Badge>
                            </div>
                            
                            {transaction.transaction_type === 'purchase' ?
                        <div className="space-y-1">
                                <p className="text-sm text-slate-600">
                                  PO: {transaction.purchase_order_number} • {transaction.quantity} ticket{transaction.quantity > 1 ? 's' : ''}
                                </p>
                                {transaction.xero_invoice_number &&
                          <p className="text-xs text-slate-500">
                                    Invoice: {transaction.xero_invoice_number}
                                  </p>
                          }
                              </div> :
                        transaction.transaction_type === 'refund' ?
                        <p className="text-sm text-slate-600">
                                {transaction.event_name} • {transaction.quantity} ticket{transaction.quantity > 1 ? 's' : ''} returned
                                {transaction.booking_reference && ` • ${transaction.booking_reference}`}
                              </p> :
                        // 'usage'
                        <p className="text-sm text-slate-600">
                                {transaction.event_name} • {transaction.quantity} ticket{transaction.quantity > 1 ? 's' : ''}
                                {transaction.booking_reference && ` • ${transaction.booking_reference}`}
                              </p>
                        }
                            
                            <p className="text-xs text-slate-500 mt-1">
                              {format(new Date(transaction.created_date), 'MMM d, yyyy • h:mm a')}
                            </p>
                          </div>
                          
                          <div className="flex items-center gap-3">
                            <div className={`flex items-center gap-1 font-semibold ${
                        transaction.transaction_type === 'purchase' ? 'text-green-600' :
                        transaction.transaction_type === 'refund' ? 'text-blue-600' :
                        'text-purple-600'}`
                        }>
                              {transaction.transaction_type === 'purchase' ?
                          <ArrowUpCircle className="w-4 h-4" /> :
                          transaction.transaction_type === 'refund' ?
                          <ArrowUpCircle className="w-4 h-4" /> :
                          // 'usage'
                          <ArrowDownCircle className="w-4 h-4" />
                          }
                              <span>
                                {transaction.transaction_type === 'usage' ? '-' : '+'}
                                {transaction.quantity}
                              </span>
                            </div>

                            {transaction.xero_invoice_pdf_uri &&
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewInvoice(transaction)}
                          disabled={downloadingInvoice === transaction.id}
                          className="shrink-0">

                                {downloadingInvoice === transaction.id ?
                          <Loader2 className="w-4 h-4 animate-spin" /> :

                          <>
                                    <FileText className="w-4 h-4 mr-1" />
                                    Invoice
                                  </>
                          }
                              </Button>
                        }
                          </div>
                        </div>);

                })}
                  </div>
              }
              </CardContent>
            </Card>
          </> :

        <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Ticket className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Program Tickets Yet
              </h3>
              <p className="text-slate-600">
                Purchase program tickets to get started
              </p>
            </CardContent>
          </Card>
        }
      </div>

      {/* Invoice Viewer Modal */}
      <Dialog open={invoiceModalOpen} onOpenChange={handleModalClose}>
        <DialogContent className="max-w-4xl h-[90vh] p-0 flex flex-col">
          <DialogHeader className="p-6 pb-4 border-b border-slate-200 shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle>
                Invoice {currentInvoiceNumber || 'Preview'}
              </DialogTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadInvoice}
                className="gap-2">

                <Download className="w-4 h-4" />
                Download
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0">
            {currentInvoiceUrl ?
            <iframe
              src={currentInvoiceUrl}
              className="w-full h-full border-0"
              title="Invoice PDF" /> :


            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-8 h-8 animate-spin text-slate-400" />
              </div>
            }
          </div>
        </DialogContent>
      </Dialog>
    </div>);

}
