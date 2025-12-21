import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, Shield, Download, BarChart3, ChevronDown, ChevronRight, ChevronLeft, Building2, Filter } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

const MEMBERS_PER_PAGE = 25;

export default function MemberRoleReportPage() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [expandedRoles, setExpandedRoles] = useState({});
  const [rolePages, setRolePages] = useState({});
  const [selectedSegment, setSelectedSegment] = useState("all");

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded('admin.member-role-assignment')) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  useEffect(() => {
    setRolePages({});
  }, [selectedSegment]);

  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['roles-list'],
    queryFn: () => base44.entities.Role.list('name'),
  });

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['members-list-all'],
    queryFn: () => base44.entities.Member.listAll(),
  });

  const { data: organizations = [], isLoading: loadingOrgs } = useQuery({
    queryKey: ['organizations-list-all'],
    queryFn: () => base44.entities.Organization.listAll(),
  });

  const { data: segmentationFieldSetting } = useQuery({
    queryKey: ['role-segmentation-field-setting'],
    queryFn: async () => {
      const allSettings = await base44.entities.SystemSettings.list();
      return allSettings.find(s => s.setting_key === 'role_segmentation_field_id');
    }
  });

  const segmentationFieldId = segmentationFieldSetting?.setting_value || null;

  const { data: orgPreferenceFields = [] } = useQuery({
    queryKey: ['org-preference-fields-for-segmentation'],
    queryFn: async () => {
      const fields = await base44.entities.PreferenceField.list({
        filter: { entity_scope: 'organization', is_active: true }
      });
      return (fields || []).filter(f => f.field_type === 'picklist' || f.field_type === 'dropdown');
    }
  });

  const { data: orgPreferenceValues = [] } = useQuery({
    queryKey: ['org-preference-values-all'],
    queryFn: () => base44.entities.OrganizationPreferenceValue.listAll(),
    enabled: !!segmentationFieldId
  });

  const segmentationField = orgPreferenceFields.find(f => f.id === segmentationFieldId);

  const segmentOptions = useMemo(() => {
    if (!segmentationField?.options) return [];
    try {
      const opts = typeof segmentationField.options === 'string' 
        ? JSON.parse(segmentationField.options) 
        : segmentationField.options;
      return Array.isArray(opts) ? opts : [];
    } catch {
      return [];
    }
  }, [segmentationField]);

  const orgMap = useMemo(() => {
    const map = {};
    organizations.forEach(org => {
      map[org.id] = org;
    });
    return map;
  }, [organizations]);

  const orgSegmentMap = useMemo(() => {
    if (!segmentationFieldId) return {};
    const map = {};
    orgPreferenceValues.forEach(pv => {
      if (pv.field_id === segmentationFieldId && pv.organization_id) {
        map[pv.organization_id] = pv.value;
      }
    });
    return map;
  }, [orgPreferenceValues, segmentationFieldId]);

  const filteredMembers = useMemo(() => {
    if (selectedSegment === "all" || !segmentationFieldId) {
      return members;
    }
    return members.filter(member => {
      if (!member.organization_id) return false;
      const orgSegment = orgSegmentMap[member.organization_id];
      return orgSegment === selectedSegment;
    });
  }, [members, selectedSegment, segmentationFieldId, orgSegmentMap]);

  const roleStats = useMemo(() => {
    const stats = roles.map(role => {
      const roleMembers = filteredMembers.filter(m => m.role_id === role.id);
      return {
        role,
        memberCount: roleMembers.length,
        members: roleMembers.sort((a, b) => {
          const nameA = `${a.first_name || ''} ${a.last_name || ''}`.toLowerCase();
          const nameB = `${b.first_name || ''} ${b.last_name || ''}`.toLowerCase();
          return nameA.localeCompare(nameB);
        })
      };
    });

    const noRoleMembers = filteredMembers.filter(m => !m.role_id);
    if (noRoleMembers.length > 0) {
      stats.push({
        role: { id: 'no-role', name: 'No Role Assigned', is_admin: false },
        memberCount: noRoleMembers.length,
        members: noRoleMembers.sort((a, b) => {
          const nameA = `${a.first_name || ''} ${a.last_name || ''}`.toLowerCase();
          const nameB = `${b.first_name || ''} ${b.last_name || ''}`.toLowerCase();
          return nameA.localeCompare(nameB);
        })
      });
    }

    return stats.sort((a, b) => b.memberCount - a.memberCount);
  }, [roles, filteredMembers]);

  const totalMembers = filteredMembers.length;
  const totalRoles = roles.length;

  const toggleRoleExpand = (roleId) => {
    setExpandedRoles(prev => ({
      ...prev,
      [roleId]: !prev[roleId]
    }));
    if (!rolePages[roleId]) {
      setRolePages(prev => ({ ...prev, [roleId]: 1 }));
    }
  };

  const setRolePage = (roleId, page) => {
    setRolePages(prev => ({ ...prev, [roleId]: page }));
  };

  const handleExportCSV = () => {
    const csvRows = [
      ['Role Name', 'Member Count', 'Member Name', 'Member Email', 'Organisation']
    ];

    roleStats.forEach(stat => {
      if (stat.members.length === 0) {
        csvRows.push([
          stat.role.name,
          '0',
          '',
          '',
          ''
        ]);
      } else {
        stat.members.forEach((member, idx) => {
          const org = orgMap[member.organization_id];
          csvRows.push([
            idx === 0 ? stat.role.name : '',
            idx === 0 ? stat.memberCount.toString() : '',
            `${member.first_name || ''} ${member.last_name || ''}`.trim(),
            member.email || '',
            org?.name || ''
          ]);
        });
      }
    });

    const csvContent = csvRows.map(row => 
      row.map(cell => `"${(cell || '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const segmentSuffix = selectedSegment !== 'all' ? `-${selectedSegment.replace(/\s+/g, '-')}` : '';
    link.download = `member-role-report${segmentSuffix}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  const isLoading = loadingRoles || loadingMembers || loadingOrgs;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800" data-testid="text-page-title">
            Member Role Report
          </h1>
          <p className="text-slate-600 mt-1">
            Overview of member counts per role
          </p>
        </div>
        <div className="flex items-center gap-3">
          {segmentationFieldId && segmentOptions.length > 0 && (
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-500" />
              <Select value={selectedSegment} onValueChange={setSelectedSegment}>
                <SelectTrigger className="w-[200px]" data-testid="select-segment-filter">
                  <SelectValue placeholder="All segments" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All {segmentationField?.label || 'Segments'}</SelectItem>
                  {segmentOptions.map(opt => {
                    const optValue = typeof opt === 'object' ? (opt.value || opt.label) : opt;
                    const optLabel = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                    return (
                      <SelectItem key={optValue} value={optValue}>{optLabel}</SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}
          <Button 
            onClick={handleExportCSV} 
            variant="outline"
            disabled={isLoading}
            data-testid="button-export-csv"
          >
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-100 rounded-lg">
                <Users className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-slate-600">
                  {selectedSegment !== 'all' ? 'Filtered Members' : 'Total Members'}
                </p>
                <p className="text-2xl font-bold text-slate-800" data-testid="text-total-members">
                  {isLoading ? '...' : totalMembers}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-purple-100 rounded-lg">
                <Shield className="w-6 h-6 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-slate-600">Total Roles</p>
                <p className="text-2xl font-bold text-slate-800" data-testid="text-total-roles">
                  {isLoading ? '...' : totalRoles}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-green-100 rounded-lg">
                <BarChart3 className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-slate-600">Avg Members/Role</p>
                <p className="text-2xl font-bold text-slate-800" data-testid="text-avg-members">
                  {isLoading ? '...' : totalRoles > 0 ? (totalMembers / totalRoles).toFixed(1) : '0'}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {selectedSegment !== 'all' && (
        <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2">
          <Filter className="w-4 h-4 text-blue-600" />
          <span className="text-sm text-blue-800">
            Filtering by {segmentationField?.label}: <strong>{selectedSegment}</strong>
          </span>
          <Button 
            variant="ghost" 
            size="sm" 
            className="ml-auto text-blue-600 hover:text-blue-800"
            onClick={() => setSelectedSegment('all')}
            data-testid="button-clear-filter"
          >
            Clear filter
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="w-5 h-5" />
            Members by Role
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          ) : roleStats.length === 0 ? (
            <div className="text-center py-8 text-slate-500">
              No roles or members found
            </div>
          ) : (
            <div className="space-y-2">
              {roleStats.map((stat) => {
                const isExpanded = expandedRoles[stat.role.id];
                const totalPages = Math.max(1, Math.ceil(stat.members.length / MEMBERS_PER_PAGE));
                const currentPage = Math.min(rolePages[stat.role.id] || 1, totalPages);
                const startIdx = (currentPage - 1) * MEMBERS_PER_PAGE;
                const paginatedMembers = stat.members.slice(startIdx, startIdx + MEMBERS_PER_PAGE);

                return (
                  <div 
                    key={stat.role.id} 
                    className="border border-slate-200 rounded-lg overflow-hidden"
                    data-testid={`card-role-${stat.role.id}`}
                  >
                    <button
                      onClick={() => toggleRoleExpand(stat.role.id)}
                      className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 transition-colors text-left"
                      data-testid={`button-expand-role-${stat.role.id}`}
                    >
                      <div className="flex items-center gap-3">
                        {isExpanded ? (
                          <ChevronDown className="w-5 h-5 text-slate-400" />
                        ) : (
                          <ChevronRight className="w-5 h-5 text-slate-400" />
                        )}
                        <span className="font-medium text-slate-800">{stat.role.name}</span>
                      </div>
                      <Badge 
                        variant="outline" 
                        className="text-blue-600 border-blue-200 bg-blue-50"
                        data-testid={`text-member-count-${stat.role.id}`}
                      >
                        {stat.memberCount} {stat.memberCount === 1 ? 'member' : 'members'}
                      </Badge>
                    </button>
                    
                    {isExpanded && stat.members.length > 0 && (
                      <div className="border-t border-slate-200 bg-white">
                        <div className="overflow-x-auto">
                          <table className="w-full">
                            <thead className="bg-slate-50">
                              <tr>
                                <th className="text-left px-4 py-2 text-sm font-medium text-slate-600">Name</th>
                                <th className="text-left px-4 py-2 text-sm font-medium text-slate-600">Email</th>
                                <th className="text-left px-4 py-2 text-sm font-medium text-slate-600">
                                  <div className="flex items-center gap-1">
                                    <Building2 className="w-4 h-4" />
                                    Organisation
                                  </div>
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {paginatedMembers.map((member, idx) => {
                                const org = orgMap[member.organization_id];
                                return (
                                  <tr 
                                    key={member.id} 
                                    className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}
                                    data-testid={`row-member-${member.id}`}
                                  >
                                    <td className="px-4 py-2 text-sm text-slate-800">
                                      {member.first_name} {member.last_name}
                                    </td>
                                    <td className="px-4 py-2 text-sm text-slate-600">
                                      {member.email}
                                    </td>
                                    <td className="px-4 py-2 text-sm text-slate-600">
                                      {org?.name || <span className="text-slate-400 italic">No organisation</span>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        
                        {totalPages > 1 && (
                          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 bg-slate-50">
                            <span className="text-sm text-slate-600">
                              Showing {startIdx + 1}-{Math.min(startIdx + MEMBERS_PER_PAGE, stat.members.length)} of {stat.members.length}
                            </span>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRolePage(stat.role.id, currentPage - 1)}
                                disabled={currentPage === 1}
                                data-testid={`button-prev-page-${stat.role.id}`}
                              >
                                <ChevronLeft className="w-4 h-4" />
                                Previous
                              </Button>
                              <span className="text-sm text-slate-600 px-2">
                                Page {currentPage} of {totalPages}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setRolePage(stat.role.id, currentPage + 1)}
                                disabled={currentPage === totalPages}
                                data-testid={`button-next-page-${stat.role.id}`}
                              >
                                Next
                                <ChevronRight className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    
                    {isExpanded && stat.members.length === 0 && (
                      <div className="border-t border-slate-200 p-4 text-center text-slate-500 text-sm">
                        No members assigned to this role
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
