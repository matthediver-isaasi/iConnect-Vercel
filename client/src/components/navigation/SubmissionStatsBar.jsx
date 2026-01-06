import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";

export default function SubmissionStatsBar() {
  const navigate = useNavigate();
  const { memberInfo } = useMemberAccess();
  
  const { data: stats, isLoading, isError } = useQuery({
    queryKey: ['form-submission-stats'],
    queryFn: async () => {
      try {
        const response = await fetch('/api/admin/form-submissions/stats', {
          credentials: 'include'
        });
        if (!response.ok) {
          return null;
        }
        return response.json();
      } catch (err) {
        console.error('[SubmissionStatsBar] Fetch error:', err);
        return null;
      }
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    retry: false
  });

  if (isLoading || isError || !stats) {
    return null;
  }

  const allowedRoles = stats.allowed_roles || [];
  const userRoleId = memberInfo?.role_id;
  
  if (allowedRoles.length > 0 && (!userRoleId || !allowedRoles.includes(userRoleId))) {
    return null;
  }

  const handleClick = () => {
    navigate(createPageUrl("FormSubmissions"));
  };

  return (
    <div className="px-3 py-2">
      <div 
        onClick={handleClick}
        className="flex items-center gap-2 px-3 py-2 rounded-md bg-slate-50 hover:bg-slate-100 transition-colors border border-slate-200 cursor-pointer"
        data-testid="link-submission-stats"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      >
        <FileText className="w-4 h-4 text-slate-500 flex-shrink-0" />
        <span className="text-sm text-slate-700">
          {stats.total} submission{stats.total !== 1 ? 's' : ''}
        </span>
        {stats.new > 0 && (
          <Badge 
            variant="default" 
            className="ml-auto bg-blue-600 text-white text-xs px-1.5 py-0"
            data-testid="badge-new-submissions"
          >
            {stats.new} new
          </Badge>
        )}
      </div>
    </div>
  );
}
