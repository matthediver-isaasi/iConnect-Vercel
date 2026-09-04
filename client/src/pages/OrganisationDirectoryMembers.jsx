import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2, Search, Users } from "lucide-react";
import { DirectoryMemberCard } from "@/components/directory/DirectoryCards";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import { normalizeMemberDepartments, uniqueMemberRows } from "@/lib/memberListColumnUtils.mjs";

export default function OrganisationDirectoryMembers({ dynamic = false }) {
  const { slug, organizationId } = useParams();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [departmentIds, setDepartmentIds] = useState([]);
  const [page, setPage] = useState(1);
  const pageSize = 12;

  useEffect(() => {
    setPage(1);
  }, [search, departmentIds, organizationId, slug]);

  useEffect(() => {
    setDepartmentIds([]);
  }, [organizationId, slug]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["organisation-directory-members", dynamic ? slug : "standard", organizationId, search, departmentIds, page],
    queryFn: async () => {
      const params = new URLSearchParams({ organization_id: organizationId });
      if (dynamic) params.set("slug", slug);
      else params.set("source", "standard");
      if (search.trim()) params.set("search", search.trim());
      if (departmentIds.length > 0) params.set("department_id", departmentIds.join(","));
      params.set("page", String(page));
      params.set("limit", String(pageSize));
      const response = await fetch(`/api/dynamic-directory/members?${params}`, { credentials: "include" });
      if (response.status === 401) {
        const destination = window.location.pathname + window.location.search;
        window.location.href = `/login?redirect=${encodeURIComponent(destination)}`;
        return null;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Unable to load organisation members");
      }
      return response.json();
    },
    enabled: !!organizationId && (!dynamic || !!slug),
  });

  if (isLoading || !data) {
    if (error) {
      return (
        <div className="min-h-screen p-8 flex items-center justify-center">
          <Card><CardContent className="p-8 text-center text-slate-700">{error.message}</CardContent></Card>
        </div>
      );
    }
    return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-600" /></div>;
  }

  const backUrl = dynamic ? `/directory/${encodeURIComponent(slug)}` : "/OrganisationDirectory";
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const directoryMembers = uniqueMemberRows(data.members);
  const departmentOptions = normalizeMemberDepartments({ departments: data.departments });
  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <Button variant="ghost" className="mb-4 gap-2" onClick={() => navigate(backUrl)}>
          <ArrowLeft className="w-4 h-4" /> Back to organisations
        </Button>
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Users className="w-8 h-8 text-blue-600" />
            <h1 className="text-3xl font-bold text-slate-900">{data.organization.name} members</h1>
          </div>
          <p className="text-slate-600">{data.total} eligible {data.total === 1 ? "member" : "members"}</p>
        </div>
        <Card className="mb-6"><CardContent className="p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search members..." />
            </div>
            {data.departments?.length > 0 && (
              <MultiSelectFilter
                className="sm:w-56"
                options={departmentOptions.map((department) => ({
                  value: department.id,
                  label: department.name,
                }))}
                selected={departmentIds}
                onChange={setDepartmentIds}
                placeholder="All departments"
                data-testid="select-directory-department"
              />
            )}
          </div>
        </CardContent></Card>
        {directoryMembers.length === 0 ? (
          <Card><CardContent className="p-12 text-center text-slate-600">No eligible members found</CardContent></Card>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {directoryMembers.map((member) => (
                <DirectoryMemberCard
                  key={member.id}
                  member={member}
                  role={data.roles.find((role) => role.id === member.role_id)}
                  organization={data.organization}
                  displaySettings={data.displaySettings}
                  isGuest={false}
                />
              ))}
            </div>
            {totalPages > 1 && (
              <div className="mt-6 flex items-center justify-center gap-3">
                <Button variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                  Previous
                </Button>
                <span className="text-sm text-slate-600">Page {page} of {totalPages}</span>
                <Button variant="outline" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}