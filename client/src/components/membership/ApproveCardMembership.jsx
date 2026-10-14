import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";

export default function ApproveCardMembership({ memberId, record, allowed }) {
  const [open, setOpen] = useState(false);
  const cache = useQueryClient();
  const approval = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/membership/member-membership", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve_card_membership", memberId, historyId: record.id }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error || "Could not approve membership");
      return result;
    },
    onSuccess: async result => {
      toast.success(result.detail);
      setOpen(false);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["member-membership", memberId] }),
        cache.invalidateQueries({ queryKey: ["member", memberId] }),
        cache.invalidateQueries({ predicate: q => String(q.queryKey[0]).toLowerCase().includes("nmc") }),
      ]);
    },
    onError: error => toast.error(error.message),
  });
  if (!allowed || record.status !== "pending_activation" || record.payment_method !== "card_monthly"
    || !["partial", "paid"].includes(record.payment_status)
    || record.membership_source === "organisation") return null;
  return <>
    <Button size="sm" variant="outline" className="mt-2" onClick={() => setOpen(true)}
      data-testid={`approve-card-membership-${record.id}`}>Activate membership</Button>
    <Dialog open={open} onOpenChange={value => { if (!approval.isPending) setOpen(value); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve monthly card membership?</DialogTitle>
          <DialogDescription>
            This approves the membership using its recorded successful payment. It will become active
            now, or on its agreed start date if that is in the future. It does not take another payment,
            change the subscription or change the agreed membership dates.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={approval.isPending} onClick={() => setOpen(false)}>Cancel</Button>
          <Button disabled={approval.isPending} onClick={() => approval.mutate()}>
            {approval.isPending ? "Approving…" : "Approve membership"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
