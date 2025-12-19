import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, Calendar, AlertTriangle, Clock, Search, FileText } from "lucide-react";
import { format, addDays, isBefore, isAfter } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function MemberGroupAssignmentReportPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('membership.member-groups')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);
  const [searchQuery, setSearchQuery] = useState('');
  const [expiryFilter, setExpiryFilter] = useState('all');
  const [groupFilter, setGroupFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  const { data: groups = [], isLoading: loadingGroups } = useQuery({
    queryKey: ['member-groups'],
    queryFn: () => base44.entities.MemberGroup.list('name'),
  });

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['members-list-all'],
    queryFn: () => base44.entities.Member.listAll(),
  });

  const { data: guests = [], isLoading: loadingGuests } = useQuery({
    queryKey: ['member-group-guests-all'],
    queryFn: () => base44.entities.MemberGroupGuest.listAll(),
  });

  const { data: assignments = [], isLoading: loadingAssignments } = useQuery({
    queryKey: ['member-group-assignments-all'],
    queryFn: () => base44.entities.MemberGroupAssignment.listAll(),
  });

  const today = new Date();
  const thirtyDaysFromNow = addDays(today, 30);

  const getExpiryStatus = (expiresAt) => {
    if (!expiresAt) return 'no-expiry';
    const expiryDate = new Date(expiresAt);
    if (isBefore(expiryDate, today)) return 'expired';
    if (isBefore(expiryDate, thirtyDaysFromNow)) return 'expiring-soon';
    return 'active';
  };

  const enrichedAssignments = useMemo(() => {
    return assignments.map(assignment => {
      const isGuest = !!assignment.guest_id;
      const member = !isGuest ? members.find(m => m.id === assignment.member_id) : null;
      const guest = isGuest ? guests.find(g => g.id === assignment.guest_id) : null;
      const group = groups.find(g => g.id === assignment.group_id);
      const expiryStatus = getExpiryStatus(assignment.expires_at);
      
      let memberName = 'Unknown';
      let memberEmail = '';
      
      if (isGuest && guest) {
        memberName = `${guest.full_name || guest.name || 'Guest'} (Guest)`;
        memberEmail = guest.email || '';
      } else if (member) {
        memberName = `${member.first_name} ${member.last_name}`;
        memberEmail = member.email || '';
      }
      
      return {
        ...assignment,
        member,
        guest,
        group,
        isGuest,
        expiryStatus,
        memberName,
        memberEmail,
        groupName: group?.name || 'Unknown Group'
      };
    });
  }, [assignments, members, guests, groups]);

  const filteredAssignments = useMemo(() => {
    let filtered = enrichedAssignments;

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(a => 
        a.memberName.toLowerCase().includes(query) ||
        a.memberEmail.toLowerCase().includes(query) ||
        a.groupName.toLowerCase().includes(query) ||
        a.group_role?.toLowerCase().includes(query)
      );
    }

    // Expiry filter
    if (expiryFilter !== 'all') {
      filtered = filtered.filter(a => a.expiryStatus === expiryFilter);
    }

    // Group filter
    if (groupFilter !== 'all') {
      filtered = filtered.filter(a => a.group_id === groupFilter);
    }

    // Sort by expiry date (expired first, then expiring soon, then by date)
    filtered.sort((a, b) => {
      const statusOrder = { 'expired': 0, 'expiring-soon': 1, 'active': 2, 'no-expiry': 3 };
      if (statusOrder[a.expiryStatus] !== statusOrder[b.expiryStatus]) {
        return statusOrder[a.expiryStatus] - statusOrder[b.expiryStatus];
      }
      if (a.expires_at && b.expires_at) {
        return new Date(a.expires_at) - new Date(b.expires_at);
      }
      return a.memberName.localeCompare(b.memberName);
    });

    return filtered;
  }, [enrichedAssignments, searchQuery, expiryFilter, groupFilter]);

  // Stats
  const stats = useMemo(() => {
    const expired = enrichedAssignments.filter(a => a.expiryStatus === 'expired').length;
    const expiringSoon = enrichedAssignments.filter(a => a.expiryStatus === 'expiring-soon').length;
    const withExpiry = enrichedAssignments.filter(a => a.expires_at).length;
    return { expired, expiringSoon, withExpiry, total: enrichedAssignments.length };
  }, [enrichedAssignments]);

  // Pagination
  const totalPages = Math.ceil(filteredAssignments.length / itemsPerPage);
  const paginatedAssignments = filteredAssignments.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, expiryFilter, groupFilter]);

  const getStatusBadge = (status) => {
    switch (status) {
      case 'expired':
        return <Badge className="bg-red-100 text-red-700">Expired</Badge>;
      case 'expiring-soon':
        return <Badge className="bg-amber-100 text-amber-700">Expiring Soon</Badge>;
      case 'active':
        return <Badge className="bg-green-100 text-green-700">Active</Badge>;
      default:
        return <Badge className="bg-slate-100 text-slate-600">No Expiry</Badge>;
    }
  };

  const isLoading = loadingGroups || loadingMembers || loadingAssignments;

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
            Group Assignments Report
          </h1>
          <p className="text-slate-600">View and filter all member group assignments</p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Users className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats.total}</p>
                  <p className="text-xs text-slate-600">Total Assignments</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-lg">
                  <AlertTriangle className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-red-600">{stats.expired}</p>
                  <p className="text-xs text-slate-600">Expired</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-100 rounded-lg">
                  <Clock className="w-5 h-5 text-amber-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-amber-600">{stats.expiringSoon}</p>
                  <p className="text-xs text-slate-600">Expiring in 30 days</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-slate-100 rounded-lg">
                  <Calendar className="w-5 h-5 text-slate-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900">{stats.withExpiry}</p>
                  <p className="text-xs text-slate-600">With Expiry Date</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-3">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Search by member, group, or role..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="w-full md:w-48">
                <Select value={expiryFilter} onValueChange={setExpiryFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="expired">Expired</SelectItem>
                    <SelectItem value="expiring-soon">Expiring Soon (30 days)</SelectItem>
                    <SelectItem value="active">Active (with expiry)</SelectItem>
                    <SelectItem value="no-expiry">No Expiry Date</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-full md:w-48">
                <Select value={groupFilter} onValueChange={setGroupFilter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Groups</SelectItem>
                    {groups.map(group => (
                      <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {filteredAssignments.length > 0 && (
              <p className="text-sm text-slate-600 mt-3">
                Showing {filteredAssignments.length} assignment{filteredAssignments.length !== 1 ? 's' : ''}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Results Table */}
        {isLoading ? (
          <Card>
            <CardContent className="p-8">
              <div className="animate-pulse space-y-4">
                {Array(5).fill(0).map((_, i) => (
                  <div key={i} className="h-12 bg-slate-200 rounded" />
                ))}
              </div>
            </CardContent>
          </Card>
        ) : filteredAssignments.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <FileText className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Assignments Found</h3>
              <p className="text-slate-600">
                {searchQuery || expiryFilter !== 'all' || groupFilter !== 'all' 
                  ? 'Try adjusting your filters'
                  : 'No member group assignments exist yet'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="text-left p-4 text-sm font-semibold text-slate-700">Member</th>
                      <th className="text-left p-4 text-sm font-semibold text-slate-700">Group</th>
                      <th className="text-left p-4 text-sm font-semibold text-slate-700">Role</th>
                      <th className="text-left p-4 text-sm font-semibold text-slate-700">Expiry Date</th>
                      <th className="text-left p-4 text-sm font-semibold text-slate-700">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {paginatedAssignments.map((assignment) => (
                      <tr key={assignment.id} className="hover:bg-slate-50">
                        <td className="p-4">
                          <div className="font-medium text-slate-900">{assignment.memberName}</div>
                          <div className="text-xs text-slate-500">{assignment.memberEmail}</div>
                        </td>
                        <td className="p-4">
                          <span className="text-slate-900">{assignment.groupName}</span>
                        </td>
                        <td className="p-4">
                          <Badge className="bg-blue-100 text-blue-700">{assignment.group_role}</Badge>
                        </td>
                        <td className="p-4">
                          {assignment.expires_at ? (
                            <span className="text-slate-900">
                              {format(new Date(assignment.expires_at), 'dd MMM yyyy')}
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="p-4">
                          {getStatusBadge(assignment.expiryStatus)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-6 flex justify-center">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <span className="text-sm text-slate-600 px-3">
                Page {currentPage} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}