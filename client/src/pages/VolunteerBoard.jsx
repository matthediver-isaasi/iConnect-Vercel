import React, { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Briefcase, Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import VacancyCard, {
  getPositionsAvailable,
  isVacancyClosed,
} from "@/components/vacancies/VacancyCard";
import {
  useVacancyInterest,
  VacancyInterestDialog,
} from "@/components/vacancies/useVacancyInterest";

const VACANCIES_PER_PAGE = 12;

const stripHtml = (html) =>
  (html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handle);
  }, [value, delay]);
  return debouncedValue;
}

export default function VolunteerBoardPage() {
  const { memberInfo, isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const [hideClosed, setHideClosed] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  const debouncedSearch = useDebounce(searchQuery, 300);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("jobs.volunteer-board")) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isAccessReady, isFeatureExcluded]);

  // Reset to first page whenever the filters/sort change.
  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch, groupFilter, sortBy, hideClosed]);

  const { data: vacancies = [], isLoading: loadingVacancies } = useQuery({
    queryKey: ["volunteer-board-vacancies"],
    queryFn: () => base44.entities.Vacancy.list(),
    enabled: accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: groups = [] } = useQuery({
    queryKey: ["volunteer-board-groups"],
    queryFn: () => base44.entities.MemberGroup.list(),
    enabled: accessChecked,
    staleTime: 0,
    refetchOnMount: true,
  });

  const { data: myApplications = [] } = useQuery({
    queryKey: ["my-vacancy-applications", memberInfo?.id],
    queryFn: async () => {
      if (!memberInfo?.id) return [];
      return base44.entities.VacancyApplication.filter({ member_id: memberInfo.id });
    },
    enabled: accessChecked && !!memberInfo?.id,
    staleTime: 0,
    refetchOnMount: true,
  });

  // Public form list resolves a linked form's slug from its id for the
  // "Express interest" navigation (mirrors MemberGroupDetail's non-admin path).
  const { data: publicForms = [] } = useQuery({
    queryKey: ["public-forms-for-vacancies"],
    queryFn: () => publicClient.listForms(),
    enabled: accessChecked,
    staleTime: 5 * 60 * 1000,
  });

  const formSlugById = useMemo(() => {
    const map = new Map();
    for (const f of publicForms) if (f?.id) map.set(f.id, f.slug);
    return map;
  }, [publicForms]);

  const interest = useVacancyInterest({ memberInfo, formSlugById });

  const appliedVacancyIds = useMemo(
    () => new Set(myApplications.map((a) => a.vacancy_id)),
    [myApplications]
  );

  const groupById = useMemo(() => {
    const map = new Map();
    for (const g of groups) if (g?.id) map.set(g.id, g);
    return map;
  }, [groups]);

  // Surface vacancies (open and closed) that belong to a group still visible to
  // members. Closure is derived at read time (status or past closing date).
  const boardVacancies = useMemo(
    () =>
      vacancies.filter(
        (v) => v.member_group_id && groupById.has(v.member_group_id)
      ),
    [vacancies, groupById]
  );

  const closedVacancyCount = useMemo(
    () => boardVacancies.filter((v) => isVacancyClosed(v)).length,
    [boardVacancies]
  );

  // Groups that have at least one (visible) vacancy power the filter.
  const groupOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const v of boardVacancies) {
      if (hideClosed && isVacancyClosed(v)) continue;
      if (seen.has(v.member_group_id)) continue;
      seen.add(v.member_group_id);
      const g = groupById.get(v.member_group_id);
      if (g) options.push({ id: g.id, name: g.name || "Untitled group" });
    }
    return options.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [boardVacancies, groupById, hideClosed]);

  const filteredVacancies = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    const filtered = boardVacancies.filter((v) => {
      if (hideClosed && isVacancyClosed(v)) return false;
      if (groupFilter !== "all" && v.member_group_id !== groupFilter) return false;
      if (!q) return true;
      const group = groupById.get(v.member_group_id);
      return (
        (v.role_title || "").toLowerCase().includes(q) ||
        stripHtml(v.role_description).toLowerCase().includes(q) ||
        (group?.name || "").toLowerCase().includes(q)
      );
    });
    const sorted = [...filtered].sort((a, b) => {
      if (sortBy === "title") {
        return (a.role_title || "").localeCompare(b.role_title || "", undefined, {
          sensitivity: "base",
        });
      }
      if (sortBy === "group") {
        const ag = groupById.get(a.member_group_id)?.name || "";
        const bg = groupById.get(b.member_group_id)?.name || "";
        const cmp = ag.localeCompare(bg, undefined, { sensitivity: "base" });
        if (cmp !== 0) return cmp;
        return (a.role_title || "").localeCompare(b.role_title || "", undefined, {
          sensitivity: "base",
        });
      }
      if (sortBy === "positions") {
        const ap = getPositionsAvailable(a);
        const bp = getPositionsAvailable(b);
        if (bp !== ap) return bp - ap;
        return (a.role_title || "").localeCompare(b.role_title || "", undefined, {
          sensitivity: "base",
        });
      }
      const at = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bt = b.created_at ? new Date(b.created_at).getTime() : 0;
      return sortBy === "oldest" ? at - bt : bt - at;
    });
    return sorted;
  }, [boardVacancies, debouncedSearch, groupFilter, sortBy, groupById, hideClosed]);

  const totalPages = Math.max(1, Math.ceil(filteredVacancies.length / VACANCIES_PER_PAGE));
  const pageVacancies = useMemo(() => {
    const start = (currentPage - 1) * VACANCIES_PER_PAGE;
    return filteredVacancies.slice(start, start + VACANCIES_PER_PAGE);
  }, [filteredVacancies, currentPage]);

  const isLoading = !accessChecked || loadingVacancies;

  if (isLoading) {
    return (
      <div className="min-h-screen p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-12 text-center">
            <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
            <p className="text-slate-600">Loading volunteer board...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <h1
            className="text-3xl md:text-4xl font-bold text-slate-900 mb-2"
            data-testid="text-page-title"
          >
            Volunteer Board
          </h1>
          <p className="text-slate-600">
            Browse open volunteer vacancies across all member groups and express
            your interest.
          </p>
        </div>

        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-3">
              <Input
                placeholder="Search vacancies..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="md:flex-1"
                data-testid="input-search-vacancies"
              />
              <Select value={groupFilter} onValueChange={setGroupFilter}>
                <SelectTrigger
                  className="md:w-56"
                  data-testid="select-group-filter"
                >
                  <SelectValue placeholder="All groups" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All groups</SelectItem>
                  {groupOptions.map((g) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="md:w-48" data-testid="select-sort">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="oldest">Oldest first</SelectItem>
                  <SelectItem value="title">Title (A–Z)</SelectItem>
                  <SelectItem value="group">Group (A–Z)</SelectItem>
                  <SelectItem value="positions">Most positions</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {closedVacancyCount > 0 && (
              <div className="flex items-center gap-2 mt-3">
                <Switch
                  id="toggle-hide-closed"
                  checked={hideClosed}
                  onCheckedChange={setHideClosed}
                  data-testid="switch-hide-closed"
                />
                <Label
                  htmlFor="toggle-hide-closed"
                  className="text-sm text-slate-600"
                >
                  Hide closed positions
                </Label>
              </div>
            )}
          </CardContent>
        </Card>

        {filteredVacancies.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <Briefcase className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">
                No vacancies found
              </h3>
              <p className="text-slate-600" data-testid="text-no-vacancies">
                {debouncedSearch || groupFilter !== "all"
                  ? "No vacancies match your filters."
                  : hideClosed
                    ? "There are no open volunteer vacancies right now."
                    : "There are no volunteer vacancies right now."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="flex flex-col gap-4" data-testid="list-vacancies">
              {pageVacancies.map((vacancy) => {
                const group = groupById.get(vacancy.member_group_id);
                const positionsTotal = Number(vacancy.positions_available) > 0
                  ? Number(vacancy.positions_available)
                  : 1;
                return (
                  <VacancyCard
                    key={vacancy.id}
                    vacancy={vacancy}
                    alreadyApplied={appliedVacancyIds.has(vacancy.id)}
                    positionsTotal={positionsTotal}
                    positionsRemaining={positionsTotal}
                    onExpressInterest={interest.handleExpressInterest}
                    expressDisabled={!memberInfo?.id}
                    collapsible
                    groupName={group?.name || null}
                    groupUrl={
                      group
                        ? `${createPageUrl("MemberGroupDetail")}?id=${group.id}`
                        : null
                    }
                  />
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-3 mt-6">
                <span className="text-sm text-slate-600" data-testid="text-pagination-status">
                  Showing {(currentPage - 1) * VACANCIES_PER_PAGE + 1}-
                  {Math.min(currentPage * VACANCIES_PER_PAGE, filteredVacancies.length)} of{" "}
                  {filteredVacancies.length}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Previous
                  </Button>
                  <span className="text-sm text-slate-600" data-testid="text-page-indicator">
                    Page {currentPage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    data-testid="button-next-page"
                  >
                    Next
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <VacancyInterestDialog interest={interest} />
    </div>
  );
}
