import React, { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Users, AlertCircle } from "lucide-react";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const FEATURE_ID = "membership.member-group-classification-report";

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setFullYear(from.getFullYear() - 1);
  return { from: isoDate(from), to: isoDate(to) };
}

const COLUMNS = [
  { key: "total_members", label: "Members", ranged: false },
  { key: "leadership_members", label: "Leadership Team", ranged: false },
  { key: "co_convenors", label: "Co-Convenors", ranged: false },
  { key: "emails_sent", label: "Emails Sent", ranged: true },
  { key: "vacancies_posted", label: "Volunteer Roles", ranged: true },
  { key: "resources_uploaded", label: "Resources", ranged: true },
  { key: "events_held", label: "Events Held", ranged: true },
];

export default function MemberGroupClassificationReport() {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);
  const [classificationId, setClassificationId] = useState("");
  const [{ from, to }, setRange] = useState(defaultRange);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded(FEATURE_ID)) {
        window.location.href = createPageUrl("Events");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const classificationsQuery = useQuery({
    queryKey: ["member-group-classifications"],
    queryFn: () => base44.entities.MemberGroupClassification.list("name"),
    enabled: accessChecked,
  });

  const classifications = useMemo(
    () => (Array.isArray(classificationsQuery.data) ? classificationsQuery.data : []),
    [classificationsQuery.data]
  );

  // Default: first active classification (falling back to the first overall).
  useEffect(() => {
    if (!classificationId && classifications.length > 0) {
      const firstActive = classifications.find((c) => c.is_active !== false);
      setClassificationId((firstActive || classifications[0]).id);
    }
  }, [classifications, classificationId]);

  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  const reportQuery = useQuery({
    queryKey: ["member-group-classification-report", classificationId, from, to],
    queryFn: async () => {
      const p = new URLSearchParams({ classification_id: classificationId, from, to });
      const res = await fetch(`/api/admin/member-group-classification-report?${p.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load the classification report");
      }
      return res.json();
    },
    enabled: accessChecked && !!classificationId && validRange,
    staleTime: 30 * 1000,
  });

  const rows = reportQuery.data?.rows || [];
  const totals = reportQuery.data?.totals || {};

  if (!accessChecked) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-slate-900" data-testid="text-page-title">
          Group Classification Activity Report
        </h1>
        <p className="text-slate-600 mt-1">
          Membership and activity per group within a classification. Emails, volunteer roles,
          resources and events are filtered by the selected date range; member counts are current.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label>Classification</Label>
              <Select value={classificationId} onValueChange={setClassificationId}>
                <SelectTrigger className="w-72" data-testid="select-classification">
                  <SelectValue placeholder="Select a classification" />
                </SelectTrigger>
                <SelectContent>
                  {classifications.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{c.is_active === false ? " (inactive)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="report-from">From</Label>
              <Input
                id="report-from"
                type="date"
                value={from}
                onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
                className="w-40"
                data-testid="input-report-from"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="report-to">To</Label>
              <Input
                id="report-to"
                type="date"
                value={to}
                onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
                className="w-40"
                data-testid="input-report-to"
              />
            </div>
            <div className="pb-1">
              {reportQuery.data && (
                <Badge variant="secondary" className="gap-1" data-testid="badge-group-count">
                  <Users className="w-3 h-3" />
                  {reportQuery.data.groupCount} group{reportQuery.data.groupCount === 1 ? "" : "s"} in this classification
                </Badge>
              )}
            </div>
          </div>
          {!validRange && (
            <CardDescription className="mt-2 text-red-600">
              Pick a valid date range (the start date must not be after the end date).
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {classificationsQuery.isLoading || reportQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : classificationsQuery.error ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription data-testid="text-classifications-error">
                {classificationsQuery.error.message || "Failed to load classifications"}
              </AlertDescription>
            </Alert>
          ) : classifications.length === 0 ? (
            <p className="text-slate-500 text-sm py-8 text-center" data-testid="text-no-classifications">
              No group classifications have been set up yet.
            </p>
          ) : reportQuery.error ? (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription data-testid="text-report-error">{reportQuery.error.message}</AlertDescription>
            </Alert>
          ) : rows.length === 0 ? (
            <p className="text-slate-500 text-sm py-8 text-center" data-testid="text-no-groups">
              There are no groups in this classification.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-slate-600">
                    <th className="py-2 pr-3 font-medium">Group</th>
                    {COLUMNS.map((c) => (
                      <th key={c.key} className="py-2 px-2 font-medium text-right whitespace-nowrap">
                        {c.label}
                        {c.ranged && <span className="block text-[10px] font-normal text-slate-400">in range</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.group_id} className="border-b" data-testid={`row-group-${r.group_id}`}>
                      <td className="py-2 pr-3">
                        <span className="font-medium text-slate-900">{r.group_name || r.group_id}</span>
                        {r.is_active === false && (
                          <Badge variant="outline" className="ml-2 text-xs">Inactive</Badge>
                        )}
                      </td>
                      {COLUMNS.map((c) => (
                        <td key={c.key} className="py-2 px-2 text-right whitespace-nowrap tabular-nums">
                          {Number(r[c.key]) || 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold text-slate-900">
                    <td className="py-2 pr-3" data-testid="text-total-groups">
                      Total ({rows.length} group{rows.length === 1 ? "" : "s"})
                    </td>
                    {COLUMNS.map((c) => (
                      <td
                        key={c.key}
                        className="py-2 px-2 text-right whitespace-nowrap tabular-nums"
                        data-testid={`text-total-${c.key}`}
                      >
                        {Number(totals[c.key]) || 0}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
