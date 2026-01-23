import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Calendar, Clock, Check, User, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import MeetingRequestDetailModal from "./MeetingRequestDetailModal";

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: '#f59e0b', icon: Clock },
  booked: { label: 'Booked', color: '#22c55e', icon: Check },
  cancelled: { label: 'Cancelled', color: '#6b7280', icon: Clock },
  expired: { label: 'Expired', color: '#ef4444', icon: Clock }
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

export default function MeetingRequestsCard({ formSubmissionId }) {
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleRequestClick = (request) => {
    setSelectedRequest(request);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setSelectedRequest(null);
  };

  const { data, isLoading, error } = useQuery({
    queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId],
    queryFn: () => apiRequest('GET', `/api/dd-meeting-requests/by-submission?formSubmissionId=${formSubmissionId}`),
    enabled: !!formSubmissionId
  });

  const requests = data?.requests || [];
  
  if (!formSubmissionId || (requests.length === 0 && !isLoading)) {
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

  if (error) {
    return null;
  }

  const groupedByTemplate = requests.reduce((acc, req) => {
    const templateId = req.meeting_template_id;
    if (!acc[templateId]) {
      acc[templateId] = {
        template: req.meeting_template,
        requests: []
      };
    }
    acc[templateId].requests.push(req);
    return acc;
  }, {});

  const hasBookedRequest = requests.some(r => r.status === 'booked');

  return (
    <>
      <Card className="shadow-lg" data-testid="meeting-requests-card">
        <CardHeader>
          <CardTitle className="text-lg">Meeting Requests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {requests.length > 0 ? (
            requests.map((request) => (
              <MeetingRequestItem 
                key={request.id}
                request={request}
                onClick={() => handleRequestClick(request)}
              />
            ))
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No meeting requests for this submission
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
