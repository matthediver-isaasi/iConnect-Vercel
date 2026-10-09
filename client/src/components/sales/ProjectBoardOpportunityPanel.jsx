import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { SALES_BASE_PERMISSION } from "@/lib/salesNavigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { projectTaskRequest, refreshSalesProjects, useSalesProjectTasks } from "./useSalesProjectTasks";
import { TaskError } from "./SalesProjectTaskStates";

export default function ProjectBoardOpportunityPanel({ boardId }) {
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const allowed = isAccessReady && !isFeatureExcluded(SALES_BASE_PERMISSION) && !isFeatureExcluded("sales.opportunities") && !isFeatureExcluded("projects.board-view");
  const metadata = useSalesProjectTasks({ boardId }, allowed);
  const [pendingStage, setPendingStage] = useState(null);
  const [lossReason, setLossReason] = useState("");
  const queryClient = useQueryClient();
  const opportunity = metadata.data?.opportunity;
  const stages = metadata.data?.stages || [];
  const reasons = (metadata.data?.lossReasons || []).filter((reason) => reason.is_active !== false);
  const move = useMutation({
    mutationFn: ({ stageId, lossReasonId = null }) => projectTaskRequest(`/api/opportunities/${opportunity.id}`, {
      method: "PATCH", body: JSON.stringify({ action: "move", stageId, lossReasonId, expectedVersion: opportunity.version }),
    }),
    onSuccess: () => { setPendingStage(null); setLossReason(""); },
    onSettled: () => refreshSalesProjects(queryClient),
  });
  if (!allowed || metadata.isLoading || (!metadata.error && !opportunity)) return null;
  if (metadata.error) return <div className="px-4 py-2"><TaskError error={metadata.error} onRetry={() => metadata.refetch()} /></div>;
  const stageId = opportunity.stage_id || opportunity.stage?.id;
  let value;
  try { value = new Intl.NumberFormat(undefined, { style: "currency", currency: opportunity.currency || "GBP" }).format((Number(opportunity.value_minor) || 0) / 100); }
  catch { value = `${opportunity.currency || ""} ${(Number(opportunity.value_minor) || 0) / 100}`; }
  return <div className="px-4 pt-3"><Card className="border-blue-200 bg-blue-50/40"><CardContent className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Sales opportunity</p><Link className="mt-1 block font-semibold text-blue-800 hover:underline" to={`/sales/opportunities/${opportunity.id}`}>{opportunity.name}</Link></div><Badge variant="outline">{opportunity.stage?.is_won ? "Won" : opportunity.stage?.is_lost ? "Lost" : "Open"}</Badge></div>
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm"><span>{opportunity.organization?.name || "No organisation"}</span><span className="font-medium">{value}</span><span>Owner: {opportunity.owner?.name || "Unassigned"}</span><span>Expected close: {opportunity.expected_close_date ? new Date(opportunity.expected_close_date).toLocaleDateString() : "Not set"}</span></div>
    <div className="flex flex-wrap items-center gap-3"><Label>Sales pipeline stage</Label>
      <Select value={stageId || ""} disabled={!opportunity.permissions?.canEdit || move.isPending} onValueChange={(id) => {
        if (id === stageId) return;
        const stage = stages.find((item) => item.id === id);
        if (stage?.is_lost) { setPendingStage(id); setLossReason(""); } else move.mutate({ stageId: id });
      }}><SelectTrigger className="w-56"><SelectValue placeholder={opportunity.stage?.name || "Select stage"} /></SelectTrigger><SelectContent>
        {stages.filter((stage) => stage.is_active !== false || stage.id === stageId).map((stage) => <SelectItem key={stage.id} value={stage.id} disabled={stage.is_active === false}>{stage.name}</SelectItem>)}
      </SelectContent></Select>
      <p className="text-xs text-muted-foreground">Moving project cards never changes the sales stage.</p>
    </div>
    {move.error && <p role="alert" className="text-sm text-destructive">{[409, 412].includes(move.error.status) ? "The opportunity changed elsewhere. The latest stage has been reloaded. Please try again." : move.error.message}</p>}
  </CardContent></Card>
    <Dialog open={Boolean(pendingStage)} onOpenChange={(open) => { if (!open && !move.isPending) setPendingStage(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Why was this opportunity lost?</DialogTitle><DialogDescription>Select a configured loss reason before moving this opportunity to a lost stage.</DialogDescription></DialogHeader>
      <Select value={lossReason} onValueChange={setLossReason}><SelectTrigger><SelectValue placeholder="Select loss reason" /></SelectTrigger><SelectContent>{reasons.map((reason) => <SelectItem key={reason.id} value={reason.id}>{reason.name}</SelectItem>)}</SelectContent></Select>
      {!reasons.length && <p className="text-sm text-destructive">No active loss reasons are configured. Add one in Sales settings first.</p>}
      {move.error && <p role="alert" className="text-sm text-destructive">{move.error.message}</p>}
      <DialogFooter><Button variant="outline" disabled={move.isPending} onClick={() => setPendingStage(null)}>Cancel</Button><Button disabled={!lossReason || move.isPending} onClick={() => move.mutate({ stageId: pendingStage, lossReasonId: lossReason })}>Confirm lost</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
