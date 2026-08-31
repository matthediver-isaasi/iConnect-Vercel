import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertCircle, History, Loader2, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDateFormat } from "@/hooks/useDateFormat";
import {
  buildOpportunityQuery,
  getOpportunitiesFromResponse,
  getOpportunityActivityFromResponse,
  mergeOpportunityActivity,
  opportunityActivityDate,
  opportunityActivityLabel,
  responseIncludesOpportunityActivity,
} from "@/lib/opportunityActivity";

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.message || `Unable to load Sales activity (${response.status})`);
  }
  return response.json();
}

function opportunityStage(opportunity) {
  return opportunity.stage?.name || opportunity.stageName || opportunity.stage_name || 'No stage';
}

function opportunityName(opportunity) {
  return opportunity.name || opportunity.title || 'Untitled opportunity';
}

function activityOpportunityName(item, opportunities) {
  if (item.opportunityName || item.opportunity_name) {
    return item.opportunityName || item.opportunity_name;
  }
  const id = item.opportunityId || item.opportunity_id;
  const opportunity = opportunities.find((candidate) => String(candidate.id) === String(id));
  return opportunity ? opportunityName(opportunity) : null;
}

export default function RelatedOpportunityActivity({
  organizationId,
  memberId,
  enabled = true,
  limit = 8,
}) {
  const { formatDate } = useDateFormat();
  const relatedId = organizationId || memberId;
  const relatedKind = organizationId ? 'organization' : 'member';

  const { data, isLoading, error } = useQuery({
    queryKey: ['related-opportunity-activity', relatedKind, relatedId],
    enabled: enabled && !!relatedId,
    queryFn: async () => {
      const listResponse = await fetchJson(buildOpportunityQuery({ organizationId, memberId }));
      const opportunities = getOpportunitiesFromResponse(listResponse);
      const hasIncludedActivity = responseIncludesOpportunityActivity(listResponse);
      const includedActivity = hasIncludedActivity
        ? getOpportunityActivityFromResponse(listResponse)
        : [];
      if (hasIncludedActivity) {
        return { opportunities, activity: mergeOpportunityActivity(includedActivity) };
      }

      const activityResponse = await fetchJson(
        buildOpportunityQuery({ organizationId, memberId, activity: true }),
      );
      return {
        opportunities,
        activity: mergeOpportunityActivity(
          includedActivity,
          getOpportunityActivityFromResponse(activityResponse),
        ),
      };
    },
    staleTime: 30 * 1000,
  });

  const opportunities = data?.opportunities || [];
  const activity = (data?.activity || []).slice(0, limit);

  return (
    <Card data-testid={`related-sales-activity-${relatedKind}`}>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle className="text-lg flex items-center gap-2">
          <Target className="w-5 h-5 text-emerald-600" />
          Sales
        </CardTitle>
        <Button asChild variant="outline" size="sm">
          <Link to="/sales/opportunities">View pipeline</Link>
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <div className="flex items-center justify-center py-8" data-testid="sales-activity-loading">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error.message || 'Unable to load Sales activity'}</span>
          </div>
        ) : opportunities.length === 0 && activity.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-6" data-testid="text-no-sales-activity">
            No related opportunities or Sales activity
          </p>
        ) : (
          <>
            {opportunities.length > 0 && (
              <section aria-label="Related opportunities">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-slate-700">Opportunities</h3>
                  <Badge variant="secondary">{opportunities.length}</Badge>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {opportunities.slice(0, 6).map((opportunity) => (
                    <div key={opportunity.id} className="rounded-lg border p-3 min-w-0" data-testid={`related-opportunity-${opportunity.id}`}>
                      <p className="font-medium text-sm truncate">{opportunityName(opportunity)}</p>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge variant="outline">{opportunityStage(opportunity)}</Badge>
                        {(opportunity.status || opportunity.state) && (
                          <span className="text-xs text-slate-500 capitalize">
                            {opportunity.status || opportunity.state}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            {activity.length > 0 && (
              <section aria-label="Recent Sales activity">
                <h3 className="text-sm font-medium text-slate-700 mb-2">Recent activity</h3>
                <div className="space-y-2">
                  {activity.map((item, index) => {
                    const date = opportunityActivityDate(item);
                    const validDate = date && !Number.isNaN(new Date(date).getTime());
                    const relatedName = activityOpportunityName(item, opportunities);
                    return (
                      <div key={item.id || `${date}-${index}`} className="flex items-start gap-3 rounded-lg bg-slate-50 p-3" data-testid={`sales-activity-${item.id || index}`}>
                        <History className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{opportunityActivityLabel(item)}</p>
                          <p className="text-xs text-slate-500">
                            {relatedName ? `${relatedName} · ` : ''}
                            {validDate ? formatDate(date) : 'Date unavailable'}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}