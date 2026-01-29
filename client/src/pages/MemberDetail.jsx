import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { Loader2, ArrowLeft } from "lucide-react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function MemberDetail() {
  const { id } = useParams();
  const { isAccessReady } = useMemberAccess();

  const { data: member, isLoading } = useQuery({
    queryKey: ['member-detail-minimal', id],
    enabled: isAccessReady && !!id,
    queryFn: async () => {
      return await base44.entities.Member.get(id);
    }
  });

  if (isLoading || !member) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const memberName = [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Unknown';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/members" data-testid="link-back-to-members">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <h1 className="text-xl font-semibold">{memberName}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Basic Info (Minimal Test)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p><strong>Email:</strong> {member.email || '-'}</p>
          <p><strong>Mobile:</strong> {member.mobile || '-'}</p>
          <p><strong>Job Title:</strong> {member.job_title || '-'}</p>
        </CardContent>
      </Card>

      <p className="text-sm text-slate-500">
        This is a minimal test page. Try clicking sidebar items or the back arrow to test navigation.
      </p>
    </div>
  );
}
