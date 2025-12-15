
import React from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Wallet, Ticket, Calendar, AlertCircle } from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function BalancesPage({ hasBanner }) {
  const { memberInfo, organizationInfo } = useMemberAccess();
  const { data: vouchers = [], isLoading } = useQuery({
    queryKey: ['vouchers', organizationInfo?.id],
    queryFn: async () => {
      if (!organizationInfo?.id) return [];
      const allVouchers = await base44.entities.Voucher.filter({
        organization_id: organizationInfo.id,
        status: 'active'
      });
      // Filter out expired vouchers and sort by expiry date (soonest first)
      const now = new Date();
      return allVouchers
        .filter(v => !v.expires_at || new Date(v.expires_at) > now)
        .sort((a, b) => 
          new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime()
        );
    },
    enabled: !!organizationInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  if (!memberInfo || !organizationInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const totalVoucherValue = vouchers.reduce((sum, v) => sum + v.value, 0);
  const programTicketBalances = organizationInfo.program_ticket_balances || {};
  const programNames = Object.keys(programTicketBalances).sort();
  const totalProgramTickets = Object.values(programTicketBalances).reduce((sum, val) => sum + val, 0);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header - hidden when custom banner is present */}
        {!hasBanner && (
          <div className="mb-8">
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
              Account Balances
            </h1>
            <p className="text-slate-600">
              View your organization's training fund and voucher balances
            </p>
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-6 mb-8">
          {/* Training Fund Card */}
          <Card className="border-slate-200 shadow-sm bg-gradient-to-br from-green-50 to-emerald-50">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 bg-green-600 rounded-lg">
                  <Wallet className="w-6 h-6 text-white" />
                </div>
                <div>
                  <CardTitle className="text-xl">Training Fund</CardTitle>
                  <p className="text-sm text-slate-600 mt-1">Available for program ticket purchases</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-4xl font-bold text-green-700">
                  £{(organizationInfo.training_fund_balance || 0).toFixed(2)}
                </span>
              </div>
              <p className="text-sm text-slate-600 mt-3">
                Use your training fund balance when purchasing program tickets
              </p>
            </CardContent>
          </Card>

          {/* Vouchers Summary Card */}
          <Card className="border-slate-200 shadow-sm bg-gradient-to-br from-blue-50 to-indigo-50">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 bg-blue-600 rounded-lg">
                  <Ticket className="w-6 h-6 text-white" />
                </div>
                <div>
                  <CardTitle className="text-xl">Training Vouchers</CardTitle>
                  <p className="text-sm text-slate-600 mt-1">Active vouchers available</p>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl font-bold text-blue-700">
                    £{totalVoucherValue.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <span>{vouchers.length} active {vouchers.length === 1 ? 'voucher' : 'vouchers'}</span>
                </div>
              </div>
              <p className="text-sm text-slate-600 mt-3">
                Apply vouchers when purchasing program tickets
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Program Tickets Card */}
        <Card className="border-slate-200 shadow-sm mb-8 bg-gradient-to-br from-purple-50 to-pink-50">
          <CardHeader className="border-b border-slate-200">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-purple-600 rounded-lg">
                <Ticket className="w-6 h-6 text-white" />
              </div>
              <div>
                <CardTitle className="text-xl">Program Tickets</CardTitle>
                <p className="text-sm text-slate-600 mt-1">Available tickets by program</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {programNames.length === 0 ? (
              <div className="text-center py-8">
                <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-600">No program tickets</p>
                <p className="text-sm text-slate-500 mt-1">
                  Purchase program tickets to see them here
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-white rounded-lg border-2 border-purple-200">
                  <span className="font-semibold text-slate-700">Total Tickets</span>
                  <span className="text-2xl font-bold text-purple-600">{totalProgramTickets}</span>
                </div>
                
                <div className="grid md:grid-cols-2 gap-4">
                  {programNames.map((programName) => (
                    <Card key={programName} className="border-2 border-purple-200 bg-white">
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex-1">
                            <h3 className="font-semibold text-slate-900 mb-1">{programName}</h3>
                            <p className="text-xs text-slate-500">Available tickets</p>
                          </div>
                          <div className="text-right">
                            <span className="text-3xl font-bold text-purple-600">
                              {programTicketBalances[programName]}
                            </span>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Vouchers List */}
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="border-b border-slate-200">
            <CardTitle className="text-xl">Active Vouchers</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            {isLoading ? (
              <div className="text-center py-8 text-slate-600">Loading vouchers...</div>
            ) : vouchers.length === 0 ? (
              <div className="text-center py-8">
                <Ticket className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <p className="text-slate-600">No active vouchers</p>
                <p className="text-sm text-slate-500 mt-1">
                  Vouchers will appear here when allocated to your organization
                </p>
              </div>
            ) : (
              <div className="grid md:grid-cols-2 gap-4">
                {vouchers.map((voucher) => {
                  const expiryDate = new Date(voucher.expires_at);
                  const daysUntilExpiry = differenceInDays(expiryDate, new Date());
                  const isExpiringSoon = daysUntilExpiry <= 30 && daysUntilExpiry >= 0;
                  const isExpired = daysUntilExpiry < 0;
                  
                  return (
                    <Card 
                      key={voucher.id}
                      className={`border-2 ${
                        isExpired ? 'border-red-200 bg-red-50' :
                        isExpiringSoon ? 'border-amber-200 bg-amber-50' : 
                        'border-blue-200 bg-blue-50'
                      }`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <Ticket className={`w-4 h-4 ${
                                isExpired ? 'text-red-600' :
                                isExpiringSoon ? 'text-amber-600' : 
                                'text-blue-600'
                              }`} />
                              <h3 className="font-semibold text-slate-900">{voucher.code}</h3>
                            </div>
                            {voucher.description && (
                              <p className="text-sm text-slate-600 mb-2">{voucher.description}</p>
                            )}
                          </div>
                          <Badge className="bg-green-100 text-green-700 font-semibold shrink-0 ml-2">
                            £{voucher.value.toFixed(2)}
                          </Badge>
                        </div>
                        
                        <div className="flex items-center gap-2 text-xs">
                          <Calendar className={`w-3 h-3 ${
                            isExpired ? 'text-red-600' :
                            isExpiringSoon ? 'text-amber-600' : 
                            'text-slate-400'
                          }`} />
                          <span className={
                            isExpired ? 'text-red-600 font-medium' :
                            isExpiringSoon ? 'text-amber-600 font-medium' : 
                            'text-slate-500'
                          }>
                            {isExpired ? 'Expired' : 'Expires'} {format(expiryDate, 'MMM d, yyyy')}
                            {isExpiringSoon && !isExpired && ` (${daysUntilExpiry} days)`}
                          </span>
                        </div>

                        {isExpiringSoon && !isExpired && (
                          <div className="flex items-start gap-2 mt-3 p-2 bg-amber-100 rounded-lg">
                            <AlertCircle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                            <p className="text-xs text-amber-800">
                              This voucher expires soon. Use it before it becomes invalid.
                            </p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
