import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, Check, User, Loader2, Send, Info } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import MeetingRequestDetailModal from "./MeetingRequestDetailModal";

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: '#f59e0b', icon: Clock },
  booked: { label: 'Booked', color: '#22c55e', icon: Check },
  cancelled: { label: 'Cancelled', color: '#6b7280', icon: Clock },
  expired: { label: 'Expired', color: '#ef4444', icon: Clock },
  not_sent: { label: 'Not sent', color: '#94a3b8', icon: Send }
};

function MeetingRequestItem({ request, onClick }) {
  const statusConfig = STATUS_CONFIG[request.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const recipientName = [request.recipient_first_name, request.recipient_last_name].filter(Boolean).join(' ') || request.recipient_email;
  const agentName = request.agent ? 
    [request.agent.first_name, request.agent.last_name].filter(Boolean).join(' ') : 'Unknown Agent';
  
  return (
    <div 
      className="flex items-center gap-3 p-3 rounded-lg border hover-elevate cursor-pointer"
      data-testid={`meeting-request-item-${request.recipient_email}`}
      onClick={onClick}
    >
      <div className="p-2 bg-muted rounded-md">
        <Calendar className="w-5 h-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{recipientName}</p>
        <p className="text-xs text-muted-foreground truncate">{request.recipient_email}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <Badge 
            variant="outline" 
            className="text-xs"
            style={{ borderColor: statusConfig.color, color: statusConfig.color }}
          >
            <StatusIcon className="w-3 h-3 mr-1" />
            {statusConfig.label}
          </Badge>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <User className="w-3 h-3" />
            {agentName}
          </span>
          {request.meeting_template && (
            <span className="text-xs text-muted-foreground">
              {request.meeting_template.name}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ConfiguredMeetingItem({ config }) {
  const statusConfig = STATUS_CONFIG.not_sent;
  const StatusIcon = statusConfig.icon;
  const agentNames = config.agents?.map(a => 
    [a.first_name, a.last_name].filter(Boolean).join(' ')
  ).filter(Boolean).join(', ') || 'No agents assigned';
  
  return (
    <div 
      className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30"
      data-testid={`configured-meeting-${config.config_id}`}
    >
      <div className="p-2 bg-muted rounded-md">
        <Calendar className="w-5 h-5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{config.meeting_template?.name || 'Meeting'}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <Badge 
            variant="outline" 
            className="text-xs"
            style={{ borderColor: statusConfig.color, color: statusConfig.color }}
          >
            <StatusIcon className="w-3 h-3 mr-1" />
            {statusConfig.label}
          </Badge>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <User className="w-3 h-3" />
            {agentNames}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
          <Info className="w-3 h-3" />
          Will trigger on <span className="font-medium" style={{ color: config.stage_color || 'inherit' }}>{config.stage_name}</span> stage
        </p>
      </div>
    </div>
  );
}

export default function MeetingRequestsCard({ formSubmissionId, formId }) {
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  console.log('[MeetingRequestsCard] Props:', { formSubmissionId, formId });

  const handleRequestClick = (request) => {
    setSelectedRequest(request);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedRequest(null);
  };

  const { data: sentData, isLoading: sentLoading } = useQuery({
    queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId],
    queryFn: () => apiRequest('GET', `/api/dd-meeting-requests/by-submission?formSubmissionId=${formSubmissionId}`),
    enabled: !!formSubmissionId
  });

  const { data: configuredData, isLoading: configuredLoading } = useQuery({
    queryKey: ['/api/dd-meeting-requests/configured-by-form', formId],
    queryFn: () => apiRequest('GET', `/api/dd-meeting-requests/configured-by-form?formId=${formId}`),
    enabled: !!formId
  });

  const requests = sentData?.requests || [];
  const configuredMeetings = configuredData?.configured_meetings || [];
  
  const isLoading = sentLoading || configuredLoading;
  const hasContent = requests.length > 0 || configuredMeetings.length > 0;

  console.log('[MeetingRequestsCard] State:', { 
    sentLoading, configuredLoading, isLoading,
    requestsCount: requests.length, 
    configuredMeetingsCount: configuredMeetings.length,
    hasContent,
    sentData,
    configuredData
  });

  if ((!formSubmissionId && !formId) || (!hasContent && !isLoading)) {
    console.log('[MeetingRequestsCard] Returning null - no content or IDs');
    return null;
  }

  if (isLoading) {
    return (
      <Card className="shadow-lg">
        <CardHeader>
          <CardTitle className="text-lg">Meeting Requests</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const sentTemplateIds = new Set(requests.map(r => r.meeting_template_id));
  const unsent = configuredMeetings.filter(c => !sentTemplateIds.has(c.meeting_template?.id));

  const hasBookedRequest = requests.some(r => r.status === 'booked');

  return (
    <>
      <Card className="shadow-lg" data-testid="meeting-requests-card">
        <CardHeader>
          <CardTitle className="text-lg">Meeting Requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {unsent.length > 0 && (
            <div className="space-y-2">
              {unsent.map((config) => (
                <ConfiguredMeetingItem 
                  key={config.config_id}
                  config={config}
                />
              ))}
            </div>
          )}
          
          {requests.length > 0 && (
            <div className="space-y-2">
              {requests.map((request) => (
                <MeetingRequestItem 
                  key={request.id}
                  request={request}
                  onClick={() => handleRequestClick(request)}
                />
              ))}
            </div>
          )}

          {!hasContent && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No meeting requests configured
            </p>
          )}
        </CardContent>
      </Card>

      <MeetingRequestDetailModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        request={selectedRequest}
        allRequests={requests}
        hasBookedRequest={hasBookedRequest}
        formSubmissionId={formSubmissionId}
      />
    </>
  );
}
