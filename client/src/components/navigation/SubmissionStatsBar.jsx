import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Briefcase } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
  
  // Only show the stats bar if roles are configured AND user's role is in the allowed list
  // If no roles are configured, the bar is hidden from everyone
  if (allowedRoles.length === 0 || !userRoleId || !allowedRoles.includes(userRoleId)) {
    return null;
  }

  const newSubmissions = stats.new || 0;
  const pendingJobs = stats.pending_jobs || 0;

  const handleSubmissionsClick = () => {
    navigate(createPageUrl("FormSubmissions"));
  };

  const handleJobsClick = () => {
    navigate(createPageUrl("JobPostingManagement"));
  };

  return (
    <>
      {/* Expanded view - two column card layout */}
      <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
        <div className="grid grid-cols-2 gap-2">
          {/* New Submissions Card */}
          <div 
            onClick={handleSubmissionsClick}
            className="flex flex-col items-center gap-1 p-2 rounded-md bg-blue-50 hover-elevate active-elevate-2 transition-colors border border-blue-200 cursor-pointer"
            data-testid="link-new-submissions"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmissionsClick()}
          >
            <FileText className="w-4 h-4 text-blue-600" />
            <span className="text-base font-bold text-blue-700" data-testid="text-new-submissions-count">{newSubmissions}</span>
          </div>
          
          {/* Pending Jobs Card */}
          <div 
            onClick={handleJobsClick}
            className="flex flex-col items-center gap-1 p-2 rounded-md bg-amber-50 hover-elevate active-elevate-2 transition-colors border border-amber-200 cursor-pointer"
            data-testid="link-pending-jobs"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleJobsClick()}
          >
            <Briefcase className="w-4 h-4 text-amber-600" />
            <span className="text-base font-bold text-amber-700" data-testid="text-pending-jobs-count">{pendingJobs}</span>
          </div>
        </div>
      </div>
      
      {/* Collapsed view - stacked icons with counts */}
      <div className="hidden group-data-[collapsible=icon]:flex flex-col items-center gap-2 py-2">
        <Tooltip>
          <TooltipTrigger asChild onFocus={(e) => e.preventDefault()}>
            <div 
              onClick={handleSubmissionsClick}
              className="relative flex items-center justify-center w-8 h-8 rounded-md bg-blue-600 hover-elevate active-elevate-2 transition-colors cursor-pointer"
              data-testid="link-new-submissions-collapsed"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmissionsClick()}
            >
              <span className="text-white text-xs font-bold" data-testid="text-new-submissions-count-collapsed">{newSubmissions}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {newSubmissions} new submission{newSubmissions !== 1 ? 's' : ''}
          </TooltipContent>
        </Tooltip>
        
        <Tooltip>
          <TooltipTrigger asChild onFocus={(e) => e.preventDefault()}>
            <div 
              onClick={handleJobsClick}
              className="relative flex items-center justify-center w-8 h-8 rounded-md bg-amber-500 hover-elevate active-elevate-2 transition-colors cursor-pointer"
              data-testid="link-pending-jobs-collapsed"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleJobsClick()}
            >
              <span className="text-white text-xs font-bold" data-testid="text-pending-jobs-count-collapsed">{pendingJobs}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {pendingJobs} pending job{pendingJobs !== 1 ? 's' : ''}
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}
