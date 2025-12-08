import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Users, Shield, Download, BarChart3, ChevronDown, ChevronRight } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";

export default function MemberRoleReportPage() {
  const { isAdmin, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [expandedRoles, setExpandedRoles] = useState({});

  useEffect(() => {
    if (isAccessReady) {
      if (!isAdmin) {
        window.location.href = createPageUrl('Events');
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAdmin, isAccessReady]);

  const { data: roles = [], isLoading: loadingRoles } = useQuery({
    queryKey: ['roles-list'],
    queryFn: () => base44.entities.Role.list('name'),
  });

  const { data: members = [], isLoading: loadingMembers } = useQuery({
    queryKey: ['members-list-all'],
    queryFn: () => base44.entities.Member.listAll(),
  });

  const roleStats = useMemo(() => {
    const stats = roles.map(role => {
      const roleMembers = members.filter(m => m.role_id === role.id);
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

    const noRoleMembers = members.filter(m => !m.role_id);
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
  }, [roles, members]);

  const totalMembers = members.length;
  const totalRoles = roles.length;

  const toggleRoleExpand = (roleId) => {
    setExpandedRoles(prev => ({
      ...prev,
      [roleId]: !prev[roleId]
    }));
  };

  const handleExportCSV = () => {
    const csvRows = [
      ['Role Name', 'Is Admin', 'Member Count', 'Member Names', 'Member Emails']
    ];

    roleStats.forEach(stat => {
      csvRows.push([
        stat.role.name,
        stat.role.is_admin ? 'Yes' : 'No',
        stat.memberCount.toString(),
        stat.members.map(m => `${m.first_name || ''} ${m.last_name || ''}`).join('; '),
        stat.members.map(m => m.email || '').join('; ')
      ]);
    });

    const csvContent = csvRows.map(row => 
      row.map(cell => `"${(cell || '').replace(/"/g, '""')}"`).join(',')
    ).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `member-role-report-${new Date().toISOString().split('T')[0]}.csv`;
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

  const isLoading = loadingRoles || loadingMembers;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800" data-testid="text-page-title">
            Member Role Report
          </h1>
          <p className="text-slate-600 mt-1">
            Overview of member counts per role
          </p>
        </div>
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-blue-100 rounded-lg">
                <Users className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-slate-600">Total Members</p>
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
                        {stat.role.is_admin && (
                          <Badge variant="secondary" className="bg-purple-100 text-purple-700">
                            Admin
                          </Badge>
                        )}
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
                        <table className="w-full">
                          <thead className="bg-slate-50">
                            <tr>
                              <th className="text-left px-4 py-2 text-sm font-medium text-slate-600">Name</th>
                              <th className="text-left px-4 py-2 text-sm font-medium text-slate-600">Email</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stat.members.map((member, idx) => (
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
                              </tr>
                            ))}
                          </tbody>
                        </table>
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
