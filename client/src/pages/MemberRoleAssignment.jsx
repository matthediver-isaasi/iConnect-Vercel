import React, { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Users, Search, Shield, CheckCircle2, CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { createPageUrl } from "@/utils";
import { format } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function MemberRoleAssignmentPage() {
  const { memberRole, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [pendingRoleChange, setPendingRoleChange] = useState(null); // { memberId, roleId, requiresDate }
  const [effectiveFromDate, setEffectiveFromDate] = useState(null);
  const [accessChecked, setAccessChecked] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(25);
  const queryClient = useQueryClient();

  // Redirect non-admins or those without access to this feature
  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('page_MemberRoleAssignment')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['members'],
    queryFn: () => base44.entities.Member.listAll(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => base44.entities.Role.list(),
    staleTime: 0,
    refetchOnMount: true,
  });

  const updateMemberRoleMutation = useMutation({
    mutationFn: ({ memberId, roleId, effectiveFrom }) => 
      base44.entities.Member.update(memberId, { 
        role_id: roleId,
        role_effective_from: effectiveFrom || null
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members'] });
      toast.success('Member role updated successfully');
      setPendingRoleChange(null);
      setEffectiveFromDate(null);
    },
    onError: (error) => {
      toast.error('Failed to update member role: ' + error.message);
    }
  });

  const handleRoleChange = (memberId, roleId) => {
    if (roleId === "none" || !roleId) {
      // Clearing the role - no date needed
      updateMemberRoleMutation.mutate({ memberId, roleId: null, effectiveFrom: null });
      return;
    }

    const selectedRole = roles.find(r => r.id === roleId);
    if (selectedRole?.requires_effective_from_date) {
      // Show date picker
      setPendingRoleChange({ memberId, roleId, requiresDate: true });
      setEffectiveFromDate(null);
    } else {
      // Direct update - clear the effective from date
      updateMemberRoleMutation.mutate({ memberId, roleId, effectiveFrom: null });
    }
  };

  const handleConfirmRoleWithDate = () => {
    if (!pendingRoleChange) return;
    
    if (!effectiveFromDate) {
      toast.error('Please select an Effective From date');
      return;
    }

    updateMemberRoleMutation.mutate({
      memberId: pendingRoleChange.memberId,
      roleId: pendingRoleChange.roleId,
      effectiveFrom: format(effectiveFromDate, 'yyyy-MM-dd')
    });
  };

  const filteredMembers = members.filter(member => {
    const searchLower = searchQuery.toLowerCase();
    const matchesSearch = (
      member.email?.toLowerCase().includes(searchLower) ||
      member.first_name?.toLowerCase().includes(searchLower) ||
      member.last_name?.toLowerCase().includes(searchLower)
    );
    
    const matchesRole = roleFilter === "all" || 
      (roleFilter === "none" && !member.role_id) ||
      member.role_id === roleFilter;
    
    return matchesSearch && matchesRole;
  });

  // Pagination calculations
  const totalPages = Math.ceil(filteredMembers.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedMembers = filteredMembers.slice(startIndex, endIndex);

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, roleFilter]);

  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;
    
    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        if (totalPages > 5) pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        if (totalPages > 5) pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  const handlePageChange = (page) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const getRoleName = (roleId) => {
    const role = roles.find(r => r.id === roleId);
    return role?.name || 'No Role';
  };

  const isLoading = loadingMembers || loadingRoles;

  // Show loading state while determining access
  if (!accessChecked) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  // Don't render anything for users without access (will redirect)
  if (isFeatureExcluded('page_MemberRoleAssignment')) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">
            Assign Member Roles
          </h1>
          <p className="text-slate-600">
            Assign roles to members to control their access to features
          </p>
        </div>

        {/* Search and Filter Bar */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <Input
                  placeholder="Search members by name or email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <div className="w-full md:w-64">
                <Select value={roleFilter} onValueChange={setRoleFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="Filter by role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    <SelectItem value="none">No Role Assigned</SelectItem>
                    {roles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        <div className="flex items-center gap-2">
                          <Shield className="w-3 h-3" />
                          {role.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Members List */}
        {isLoading ? (
          <div className="text-center py-12">Loading members...</div>
        ) : filteredMembers.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <Users className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No Members Found
              </h3>
              <p className="text-slate-600">
                {searchQuery ? 'Try adjusting your search' : 'No members in the system yet'}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="border-b border-slate-200">
              <CardTitle>Members ({filteredMembers.length})</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-slate-200">
                {paginatedMembers.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center gap-4 p-4 hover:bg-slate-50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h3 className="font-semibold text-slate-900 truncate">
                          {member.first_name} {member.last_name}
                        </h3>
                        {member.role_id && (
                          <Badge variant="outline" className="text-xs">
                            {getRoleName(member.role_id)}
                          </Badge>
                        )}
                        {member.role_effective_from && (
                          <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">
                            Effective: {format(new Date(member.role_effective_from), 'dd MMM yyyy')}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-slate-600 truncate">{member.email}</p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="w-48">
                        <Select
                          value={member.role_id || "none"}
                          onValueChange={(value) => 
                            handleRoleChange(member.id, value === "none" ? null : value)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select role" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">
                              <span className="text-slate-500">No Role</span>
                            </SelectItem>
                            {roles.map((role) => (
                              <SelectItem key={role.id} value={role.id}>
                                <div className="flex items-center gap-2">
                                  <Shield className="w-3 h-3" />
                                  {role.name}
                                  {role.is_default && (
                                    <span className="text-xs text-green-600">(Default)</span>
                                  )}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      
                      {member.role_id && (
                        <CheckCircle2 className="w-5 h-5 text-green-600" />
                      )}

                      {/* Date picker for pending role change */}
                      {pendingRoleChange?.memberId === member.id && (
                        <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg border border-blue-200">
                          <div className="flex-1">
                            <Label className="text-xs text-blue-700 mb-1 block">Effective From Date *</Label>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  className="w-40 justify-start text-left font-normal"
                                >
                                  <CalendarIcon className="mr-2 h-4 w-4" />
                                  {effectiveFromDate ? (
                                    format(effectiveFromDate, 'dd MMM yyyy')
                                  ) : (
                                    <span className="text-slate-500">Pick a date</span>
                                  )}
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-auto p-0" align="start">
                                <Calendar
                                  mode="single"
                                  selected={effectiveFromDate}
                                  onSelect={setEffectiveFromDate}
                                  initialFocus
                                />
                              </PopoverContent>
                            </Popover>
                          </div>
                          <Button
                            size="sm"
                            onClick={handleConfirmRoleWithDate}
                            disabled={updateMemberRoleMutation.isPending}
                            className="bg-blue-600 hover:bg-blue-700"
                          >
                            Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setPendingRoleChange(null);
                              setEffectiveFromDate(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <Card className="border-slate-200 shadow-sm mt-6">
              <CardContent className="p-4">
                <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                  {/* Items per page selector */}
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-slate-600">Items per page:</span>
                    <Select value={itemsPerPage.toString()} onValueChange={(val) => {
                      setItemsPerPage(Number(val));
                      setCurrentPage(1);
                    }}>
                      <SelectTrigger className="w-20" data-testid="select-items-per-page">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="25">25</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Page info */}
                  <div className="text-sm text-slate-600" data-testid="text-page-info">
                    Page {currentPage} of {totalPages}
                  </div>

                  {/* Page navigation */}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1}
                      data-testid="button-prev-page"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>

                    {getPageNumbers().map((page, idx) => (
                      <React.Fragment key={idx}>
                        {page === '...' ? (
                          <span className="px-2 text-slate-400">...</span>
                        ) : (
                          <Button
                            variant={currentPage === page ? "default" : "outline"}
                            size="sm"
                            onClick={() => handlePageChange(page)}
                            className={currentPage === page ? "bg-blue-600 hover:bg-blue-700" : ""}
                            data-testid={`button-page-${page}`}
                          >
                            {page}
                          </Button>
                        )}
                      </React.Fragment>
                    ))}

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      data-testid="button-next-page"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          </>
        )}
      </div>
    </div>
  );
}