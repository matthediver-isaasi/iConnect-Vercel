import { Loader2 } from "lucide-react";
import MemberCpdPointsTab from "@/components/MemberCpdPointsTab";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export function CpdPointsPage({
  useAccess = useMemberAccess,
  HistoryComponent = MemberCpdPointsTab,
}) {
  const {
    authResolved,
    sessionValidated,
    memberInfo,
    isAccessReady,
    isFeatureExcluded,
  } = useAccess();

  if (!authResolved || !sessionValidated || !isAccessReady || !memberInfo?.id) {
    return (
      <div className="flex justify-center py-16" aria-label="Loading member CPD points">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isFeatureExcluded("cpd.member_cpd")) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-muted-foreground mt-1">You do not have access to this page.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">My CPD points</h1>
        <p className="text-muted-foreground mt-1">View your current balance and complete award history.</p>
      </div>
      <HistoryComponent memberId={memberInfo.id} enabled />
    </div>
  );
}

export default CpdPointsPage;