
import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart3, Search, Download, TrendingUp, DollarSign, Ticket, Building2 } from "lucide-react";
import { format } from "date-fns";
import { createPageUrl } from "@/utils";
import OrganizationTransactionsModal from "../components/analytics/OrganizationTransactionsModal";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function TicketSalesAnalyticsPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedProgram, setSelectedProgram] = useState("all");
  const [sortBy, setSortBy] = useState("tickets_desc");
  const [selectedOrganization, setSelectedOrganization] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_TicketSalesAnalytics')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: transactions = [], isLoading: loadingTransactions } = useQuery({
    queryKey: ['all-transactions'],
    queryFn: () => base44.entities.ProgramTicketTransaction.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: organizations = [], isLoading: loadingOrganizations } = useQuery({
    queryKey: ['all-organizations'],
    queryFn: () => base44.entities.Organization.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const isLoading = loadingTransactions || loadingOrganizations;

  // Get unique programs
  const programs = useMemo(() => {
    const uniquePrograms = [...new Set(transactions.map(t => t.program_name).filter(Boolean))];
    return uniquePrograms.sort();
  }, [transactions]);

  // Aggregate sales data by organization
  const salesData = useMemo(() => {
    const orgMap = new Map();

    // Filter transactions by selected program
    const filteredTransactions = selectedProgram === 'all' 
      ? transactions 
      : transactions.filter(t => t.program_name === selectedProgram);

    // Process each transaction
    filteredTransactions.forEach(transaction => {
      const orgId = transaction.organization_id;
      if (!orgId) return;

      if (!orgMap.has(orgId)) {
        const org = organizations.find(o => o.id === orgId);
        orgMap.set(orgId, {
          organization_id: orgId,
          organization_name: org?.name || 'Unknown Organisation',
          total_tickets_purchased: 0,
          total_tickets_used: 0,
          total_tickets_refunded: 0,
          net_tickets: 0,
          total_sales_value: 0,
          programs: new Set(),
          transaction_count: 0
        });
      }

      const orgData = orgMap.get(orgId);
      orgData.transaction_count++;
      
      if (transaction.program_name) {
        orgData.programs.add(transaction.program_name);
      }

      // Aggregate based on transaction type
      if (transaction.transaction_type === 'purchase') {
        // For purchases, use net quantity (original - cancelled)
        const originalQty = transaction.original_quantity || transaction.quantity;
        const cancelledQty = transaction.cancelled_quantity || 0;
        const netPurchaseQty = originalQty - cancelledQty;
        
        orgData.total_tickets_purchased += netPurchaseQty;
        orgData.net_tickets += netPurchaseQty;
        
        // Use total_cost_before_discount if available
        const transactionValue = transaction.total_cost_before_discount || 0;
        orgData.total_sales_value += transactionValue;
      } else if (transaction.transaction_type === 'refund') {
        orgData.total_tickets_refunded += transaction.quantity || 0;
        orgData.net_tickets += transaction.quantity || 0; // Refunds add back to balance
      } else if (transaction.transaction_type === 'usage') {
        orgData.total_tickets_used += transaction.quantity || 0;
      }
      // Note: cancellation_void and reinstatement transactions are for audit trail only, don't affect these aggregates
      // - cancellation_void: The cancellation is already reflected in the purchase transaction's cancelled_quantity
      // - reinstatement: The reinstatement is already reflected by resetting the purchase transaction's cancelled_quantity to 0
    });

    return Array.from(orgMap.values());
  }, [transactions, organizations, selectedProgram]);

  // Filter and sort sales data
  const filteredAndSortedData = useMemo(() => {
    let filtered = salesData.filter(org => 
      org.organization_name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // Sort
    filtered.sort((a, b) => {
      switch (sortBy) {
        case 'tickets_desc':
          return b.total_tickets_purchased - a.total_tickets_purchased;
        case 'tickets_asc':
          return a.total_tickets_purchased - b.total_tickets_purchased;
        case 'value_desc':
          return b.total_sales_value - a.total_sales_value;
        case 'value_asc':
          return a.total_sales_value - b.total_sales_value;
        case 'name_asc':
          return a.organization_name.localeCompare(b.organization_name);
        case 'name_desc':
          return b.organization_name.localeCompare(a.organization_name);
        default:
          return 0;
      }
    });

    return filtered;
  }, [salesData, searchQuery, sortBy]);

  // Calculate totals
  const totals = useMemo(() => {
    return filteredAndSortedData.reduce((acc, org) => ({
      tickets: acc.tickets + org.total_tickets_purchased,
      value: acc.value + org.total_sales_value,
      organizations: acc.organizations + 1
    }), { tickets: 0, value: 0, organizations: 0 });
  }, [filteredAndSortedData]);

  // Export to CSV
  const handleExportCSV = () => {
    const headers = ['Organisation', 'Tickets Purchased', 'Tickets Used', 'Tickets Refunded', 'Net Tickets', 'Sales Value (£)', 'Programs', 'Transactions'];
    const rows = filteredAndSortedData.map(org => [
      org.organization_name,
      org.total_tickets_purchased,
      org.total_tickets_used,
      org.total_tickets_refunded,
      org.net_tickets,
      org.total_sales_value.toFixed(2),
      Array.from(org.programs).join('; '),
      org.transaction_count
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ticket-sales-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
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
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <BarChart3 className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900">
              Ticket Sales Analytics
            </h1>
          </div>
          <p className="text-slate-600">
            Overview of ticket sales across all organisations
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-8">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-slate-600">Total Organisations</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Building2 className="w-5 h-5 text-blue-600" />
                <span className="text-3xl font-bold text-slate-900">{totals.organizations}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-slate-600">Total Tickets Sold</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Ticket className="w-5 h-5 text-purple-600" />
                <span className="text-3xl font-bold text-slate-900">{totals.tickets}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-slate-600">Total Sales Value</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-green-600" />
                <span className="text-3xl font-bold text-slate-900">
                  £{totals.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters and Controls */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <Input
                  placeholder="Search organisations..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>

              <Select value={selectedProgram} onValueChange={setSelectedProgram}>
                <SelectTrigger className="w-full md:w-[200px]">
                  <SelectValue placeholder="Filter by program" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Programs</SelectItem>
                  {programs.map(program => (
                    <SelectItem key={program} value={program}>{program}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-full md:w-[200px]">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tickets_desc">Tickets (High to Low)</SelectItem>
                  <SelectItem value="tickets_asc">Tickets (Low to High)</SelectItem>
                  <SelectItem value="value_desc">Value (High to Low)</SelectItem>
                  <SelectItem value="value_asc">Value (Low to High)</SelectItem>
                  <SelectItem value="name_asc">Name (A-Z)</SelectItem>
                  <SelectItem value="name_desc">Name (Z-A)</SelectItem>
                </SelectContent>
              </Select>

              <Button
                variant="outline"
                onClick={handleExportCSV}
                className="gap-2"
                disabled={filteredAndSortedData.length === 0}
              >
                <Download className="w-4 h-4" />
                Export CSV
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Sales Data Table */}
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="border-b border-slate-200">
            <CardTitle>Sales by Organisation</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-12 text-center text-slate-600">Loading sales data...</div>
            ) : filteredAndSortedData.length === 0 ? (
              <div className="p-12 text-center">
                <TrendingUp className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                <h3 className="text-lg font-semibold text-slate-900 mb-2">No sales data found</h3>
                <p className="text-slate-600">Try adjusting your filters</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Organisation
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Purchased
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Used
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Refunded
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Net Balance
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Sales Value
                      </th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Programs
                      </th>
                      <th className="px-6 py-3 text-center text-xs font-medium text-slate-600 uppercase tracking-wider">
                        Transactions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-slate-200">
                    {filteredAndSortedData.map((org) => (
                      <tr 
                        key={org.organization_id} 
                        className="hover:bg-slate-50 cursor-pointer transition-colors"
                        onClick={() => setSelectedOrganization(org)}
                      >
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <Building2 className="w-4 h-4 text-slate-400" />
                            <span className="font-medium text-slate-900">{org.organization_name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <span className="font-semibold text-green-600">
                            {org.total_tickets_purchased}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-slate-600">
                          {org.total_tickets_used}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-slate-600">
                          {org.total_tickets_refunded}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <span className={`font-semibold ${org.net_tickets > 0 ? 'text-blue-600' : 'text-slate-600'}`}>
                            {org.net_tickets}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right font-semibold text-slate-900">
                          £{org.total_sales_value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-6 py-4 text-center">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                            {org.programs.size}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-center text-slate-600">
                          {org.transaction_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Organization Transactions Modal */}
      {selectedOrganization && (
        <OrganizationTransactionsModal
          organizationId={selectedOrganization.organization_id}
          organizationName={selectedOrganization.organization_name}
          programNameFilter={selectedProgram}
          memberInfo={memberInfo}
          onClose={() => setSelectedOrganization(null)}
          onTransactionUpdated={() => {
            // This will trigger a refresh of the analytics data
            setSelectedOrganization(null);
          }}
        />
      )}
    </div>
  );
}
