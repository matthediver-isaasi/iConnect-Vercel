import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, Loader2, RotateCcw, ShieldX } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getMemberBadgePanelState } from "@/lib/memberBadgePanelState";

async function request(memberId, options) {
  const response = await fetch(`/api/admin/members/${memberId}/badges`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Badge request failed");
  return data;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function MemberBadgesTab({ memberId, enabled = true }) {
  const queryClient = useQueryClient();
  const queryKey = ["member-badges", memberId];
  const [awardOpen, setAwardOpen] = useState(false);
  const [selectedBadgeId, setSelectedBadgeId] = useState("");
  const [revokeTarget, setRevokeTarget] = useState(null);
  const query = useQuery({
    queryKey,
    enabled: enabled && !!memberId,
    queryFn: () => request(memberId),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const awardMutation = useMutation({
    mutationFn: (badgeId) => request(memberId, { method: "POST", body: JSON.stringify({ badgeId }) }),
    onSuccess: () => {
      toast.success("Badge awarded");
      setAwardOpen(false);
      setSelectedBadgeId("");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const revokeMutation = useMutation({
    mutationFn: (assignmentId) => request(memberId, { method: "DELETE", body: JSON.stringify({ assignmentId }) }),
    onSuccess: () => {
      toast.success("Badge revoked");
      setRevokeTarget(null);
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });

  const panelState = getMemberBadgePanelState({
    isLoading: query.isLoading,
    isError: query.isError,
    awards: query.data?.awards,
    availableBadges: query.data?.availableBadges,
    canManage: query.data?.canManage,
  });

  if (panelState.kind === "loading") {
    return <div className="flex justify-center py-16" data-testid="member-badges-loading"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }
  if (panelState.kind === "error") {
    return (
      <Card><CardContent className="py-16 text-center text-muted-foreground" data-testid="member-badges-error">
        <ShieldX className="h-10 w-10 mx-auto mb-3 opacity-40" />
        <p className="font-medium">Couldn&apos;t load badge history</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => query.refetch()}>Try again</Button>
      </CardContent></Card>
    );
  }

  const { awards = [], availableBadges = [], canManage = false } = query.data || {};
  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Award className="h-5 w-5 text-amber-600" />Badge history</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">Active and revoked badge awards for this member.</p>
          </div>
          {panelState.showAwardControl && (
            <Button onClick={() => setAwardOpen(true)} disabled={!panelState.canAward} data-testid="button-award-member-badge">
              <Award className="h-4 w-4 mr-2" />Award badge
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {awards.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground" data-testid="member-badges-empty">
              <Award className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium">No badges awarded yet</p>
              <p className="text-sm">{canManage ? "Award a badge from the tenant library to get started." : "Badge awards will appear here."}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {awards.map((award) => (
                <div key={award.id} className="flex flex-col sm:flex-row gap-4 rounded-lg border p-4" data-testid={`member-badge-${award.id}`}>
                  <div className="h-16 w-16 shrink-0 rounded-lg border bg-muted/30 overflow-hidden flex items-center justify-center">
                    {award.badge?.image_url ? <img src={award.badge.image_url} alt={award.badge.name || "Badge"} className="h-full w-full object-contain" /> : <Award className="h-6 w-6 text-muted-foreground" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{award.badge?.name || "Deleted badge"}</p>
                      <Badge variant={award.status === "active" ? "default" : "secondary"}>{award.status === "active" ? "Active" : "Revoked"}</Badge>
                    </div>
                    {award.badge?.description && <p className="text-sm text-muted-foreground mt-1">{award.badge.description}</p>}
                    <div className="text-xs text-muted-foreground mt-2 space-y-1">
                      <p>Awarded {formatDateTime(award.awarded_at)} by {award.awarded_by_label}</p>
                      {award.revoked_at && <p>Revoked {formatDateTime(award.revoked_at)} by {award.revoked_by_label || "Staff member"}</p>}
                    </div>
                  </div>
                  {canManage && award.status === "active" && (
                    <Button variant="outline" size="sm" onClick={() => setRevokeTarget(award)} data-testid={`button-revoke-member-badge-${award.id}`}>
                      <RotateCcw className="h-4 w-4 mr-2" />Revoke
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={awardOpen} onOpenChange={setAwardOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Award badge</DialogTitle><DialogDescription>Select an active badge from the tenant library.</DialogDescription></DialogHeader>
          <div className="space-y-2">
            <Label>Badge</Label>
            <Select value={selectedBadgeId} onValueChange={setSelectedBadgeId}>
              <SelectTrigger data-testid="select-member-badge"><SelectValue placeholder="Select a badge" /></SelectTrigger>
              <SelectContent>{availableBadges.map((badge) => <SelectItem key={badge.id} value={badge.id}>{badge.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAwardOpen(false)}>Cancel</Button>
            <Button disabled={!selectedBadgeId || awardMutation.isPending} onClick={() => awardMutation.mutate(selectedBadgeId)} data-testid="button-confirm-award-member-badge">
              {awardMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}Award
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Revoke this badge?</AlertDialogTitle><AlertDialogDescription>The award will remain in the member&apos;s badge history with its revocation date and attribution.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={revokeMutation.isPending} onClick={() => revokeMutation.mutate(revokeTarget.id)} data-testid="button-confirm-revoke-member-badge">Revoke badge</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
