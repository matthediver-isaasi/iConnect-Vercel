import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Briefcase, XCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createPageUrl } from "@/utils";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { useRealtimeSubscription } from "@/hooks/useRealtimeSubscription";
import { getReadableTextColor } from "@/components/RoleBadge";

const DEFAULT_CARD_LABELS = {
  submissions: "Submissions",
  jobs: "Jobs",
  cancellations: "Cancellations",
};

// Resolve a card's configured colour/label from the stats response.
// Returns { label, expandedStyle, collapsedStyle } where the *Style objects
// are inline styles when a colour is configured, or null to fall back to the
// hardcoded Tailwind classes.
function resolveCardStyle(cardStyles, key) {
  const config = (cardStyles && cardStyles[key]) || {};
  const colour = typeof config.colour === "string" ? config.colour.trim() : "";
  const customTextColor = typeof config.textColor === "string" ? config.textColor.trim() : "";
  const label = (typeof config.label === "string" && config.label.trim())
    ? config.label.trim()
    : null;

  if (!colour && !customTextColor) {
    return { label, style: null, hasBackground: false, textColor: undefined, iconColor: undefined };
  }

  // Custom text colour wins; otherwise auto-pick a readable colour for the background.
  const textColor = customTextColor || (colour ? getReadableTextColor(colour) : undefined);

  const style = {};
  if (colour) {
    style.backgroundColor = colour;
    style.borderColor = colour;
  }
  if (textColor) {
    style.color = textColor;
  }

  return {
    label,
    style,
    hasBackground: !!colour,
    textColor,
    iconColor: textColor,
  };
}

export default function SubmissionStatsBar() {
  const navigate = useNavigate();
  const { memberInfo } = useMemberAccess();
  
  useRealtimeSubscription('form_submission', [['form-submission-stats']], {
    enabled: !!memberInfo?.tenant_id,
    tenantId: memberInfo?.tenant_id,
  });

  useRealtimeSubscription('job_posting', [['form-submission-stats']], {
    enabled: !!memberInfo?.tenant_id,
    tenantId: memberInfo?.tenant_id,
  });

  useRealtimeSubscription('booking_cancellation_request', [['form-submission-stats']], {
    enabled: !!memberInfo?.tenant_id,
    tenantId: memberInfo?.tenant_id,
  });

  useRealtimeSubscription('booking_transfer_request', [['form-submission-stats']], {
    enabled: !!memberInfo?.tenant_id,
    tenantId: memberInfo?.tenant_id,
  });

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
    staleTime: 5 * 60 * 1000,
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
  const pendingCancellationsTransfers = stats.pending_cancellations_transfers || 0;

  const cardStyles = stats.card_styles || {};
  const submissionsCard = resolveCardStyle(cardStyles, 'submissions');
  const jobsCard = resolveCardStyle(cardStyles, 'jobs');
  const cancellationsCard = resolveCardStyle(cardStyles, 'cancellations');

  const handleSubmissionsClick = () => {
    navigate(createPageUrl("FormSubmissions"));
  };

  const handleJobsClick = () => {
    navigate(createPageUrl("JobPostingManagement"));
  };

  const handleCancellationsClick = () => {
    navigate(createPageUrl("CancellationRequests"));
  };

  return (
    <>
      {/* Expanded view - three column card layout */}
      <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
        <div className="grid grid-cols-3 gap-2">
          {/* New Submissions Card */}
          <div 
            onClick={handleSubmissionsClick}
            className={`flex flex-col items-center gap-1 p-2 rounded-md hover-elevate active-elevate-2 transition-colors border cursor-pointer ${submissionsCard.hasBackground ? '' : 'bg-blue-50 border-blue-200'}`}
            style={submissionsCard.style || undefined}
            data-testid="link-new-submissions"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmissionsClick()}
          >
            <FileText className={`w-4 h-4 ${submissionsCard.iconColor ? '' : 'text-blue-600'}`} style={submissionsCard.iconColor ? { color: submissionsCard.iconColor } : undefined} />
            <span className={`text-base font-bold ${submissionsCard.textColor ? '' : 'text-blue-700'}`} data-testid="text-new-submissions-count">{newSubmissions}</span>
            {submissionsCard.label && <span className={`text-[10px] font-medium leading-tight text-center ${submissionsCard.textColor ? '' : 'text-blue-700'}`} data-testid="text-new-submissions-label">{submissionsCard.label}</span>}
          </div>
          
          {/* Pending Jobs Card */}
          <div 
            onClick={handleJobsClick}
            className={`flex flex-col items-center gap-1 p-2 rounded-md hover-elevate active-elevate-2 transition-colors border cursor-pointer ${jobsCard.hasBackground ? '' : 'bg-warning/10 border-warning/30'}`}
            style={jobsCard.style || undefined}
            data-testid="link-pending-jobs"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleJobsClick()}
          >
            <Briefcase className={`w-4 h-4 ${jobsCard.iconColor ? '' : 'text-warning'}`} style={jobsCard.iconColor ? { color: jobsCard.iconColor } : undefined} />
            <span className={`text-base font-bold ${jobsCard.textColor ? '' : 'text-warning'}`} data-testid="text-pending-jobs-count">{pendingJobs}</span>
            {jobsCard.label && <span className={`text-[10px] font-medium leading-tight text-center ${jobsCard.textColor ? '' : 'text-warning'}`} data-testid="text-pending-jobs-label">{jobsCard.label}</span>}
          </div>

          {/* Pending Cancellations / Transfers Card */}
          <div
            onClick={handleCancellationsClick}
            className={`flex flex-col items-center gap-1 p-2 rounded-md hover-elevate active-elevate-2 transition-colors border cursor-pointer ${cancellationsCard.hasBackground ? '' : 'bg-rose-50 border-rose-200'}`}
            style={cancellationsCard.style || undefined}
            data-testid="link-pending-cancellations-transfers"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && handleCancellationsClick()}
          >
            <XCircle className={`w-4 h-4 ${cancellationsCard.iconColor ? '' : 'text-rose-600'}`} style={cancellationsCard.iconColor ? { color: cancellationsCard.iconColor } : undefined} />
            <span className={`text-base font-bold ${cancellationsCard.textColor ? '' : 'text-rose-700'}`} data-testid="text-pending-cancellations-transfers-count">{pendingCancellationsTransfers}</span>
            {cancellationsCard.label && <span className={`text-[10px] font-medium leading-tight text-center ${cancellationsCard.textColor ? '' : 'text-rose-700'}`} data-testid="text-pending-cancellations-transfers-label">{cancellationsCard.label}</span>}
          </div>
        </div>
      </div>
      
      {/* Collapsed view - stacked icons with counts */}
      <div className="hidden group-data-[collapsible=icon]:flex flex-col items-center gap-2 py-2">
        <Tooltip>
          <TooltipTrigger asChild onFocus={(e) => e.preventDefault()}>
            <div 
              onClick={handleSubmissionsClick}
              className={`relative flex items-center justify-center w-8 h-8 rounded-md hover-elevate active-elevate-2 transition-colors cursor-pointer ${submissionsCard.hasBackground ? '' : 'bg-blue-600'}`}
              style={submissionsCard.hasBackground ? { backgroundColor: submissionsCard.style.backgroundColor } : undefined}
              data-testid="link-new-submissions-collapsed"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleSubmissionsClick()}
            >
              <span className={`text-xs font-bold ${submissionsCard.iconColor ? '' : 'text-white'}`} style={submissionsCard.iconColor ? { color: submissionsCard.iconColor } : undefined} data-testid="text-new-submissions-count-collapsed">{newSubmissions}</span>
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
              className={`relative flex items-center justify-center w-8 h-8 rounded-md hover-elevate active-elevate-2 transition-colors cursor-pointer ${jobsCard.hasBackground ? '' : 'bg-warning'}`}
              style={jobsCard.hasBackground ? { backgroundColor: jobsCard.style.backgroundColor } : undefined}
              data-testid="link-pending-jobs-collapsed"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleJobsClick()}
            >
              <span className={`text-xs font-bold ${jobsCard.iconColor ? '' : 'text-white'}`} style={jobsCard.iconColor ? { color: jobsCard.iconColor } : undefined} data-testid="text-pending-jobs-count-collapsed">{pendingJobs}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {pendingJobs} pending job{pendingJobs !== 1 ? 's' : ''}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild onFocus={(e) => e.preventDefault()}>
            <div
              onClick={handleCancellationsClick}
              className={`relative flex items-center justify-center w-8 h-8 rounded-md hover-elevate active-elevate-2 transition-colors cursor-pointer ${cancellationsCard.hasBackground ? '' : 'bg-rose-600'}`}
              style={cancellationsCard.hasBackground ? { backgroundColor: cancellationsCard.style.backgroundColor } : undefined}
              data-testid="link-pending-cancellations-transfers-collapsed"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleCancellationsClick()}
            >
              <span className={`text-xs font-bold ${cancellationsCard.iconColor ? '' : 'text-white'}`} style={cancellationsCard.iconColor ? { color: cancellationsCard.iconColor } : undefined} data-testid="text-pending-cancellations-transfers-count-collapsed">{pendingCancellationsTransfers}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right">
            {pendingCancellationsTransfers} pending cancellation{pendingCancellationsTransfers !== 1 ? 's' : ''}/transfer{pendingCancellationsTransfers !== 1 ? 's' : ''}
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  );
}
