import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar, Clock, Check, User, Loader2, Send, Info, Settings } from "lucide-react";
import { format } from 'date-fns';
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";
import MeetingRequestDetailModal from "./MeetingRequestDetailModal";

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: '#f59e0b', icon: Clock },
  booked: { label: 'Booked', color: '#22c55e', icon: Check },
  cancelled: { label: 'Cancelled', color: '#6b7280', icon: Clock },
  expired: { label: 'Expired', color: '#ef4444', icon: Clock },
  not_sent: { label: 'Not sent', color: '#94a3b8', icon: Send }
};

function MeetingRequestItem({ request, onClick, onOverride, isOverriding, hasBookedRequest }) {
  const [isOverrideOpen, setIsOverrideOpen] = useState(false);
  const [overrideDateTime, setOverrideDateTime] = useState('');
  
  const statusConfig = STATUS_CONFIG[request.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const recipientName = [request.recipient_first_name, request.recipient_last_name].filter(Boolean).join(' ') || request.recipient_email;
  const agentName = request.agent ? 
    [request.agent.first_name, request.agent.last_name].filter(Boolean).join(' ') : 'Unknown Agent';
  const canOverride = (request.status === 'pending' || request.status === 'not_sent') && !hasBookedRequest;
  const isBooked = request.status === 'booked';
  
  const handleOverrideSubmit = () => {
    if (!overrideDateTime) return;
    onOverride(request.id, overrideDateTime);
    setIsOverrideOpen(false);
    setOverrideDateTime('');
  };

  return (
    <div 
      className={`flex items-center gap-3 p-3 rounded-lg border hover-elevate cursor-pointer ${isBooked ? 'border-green-500 bg-green-50' : ''}`}
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
        {(request.booking || request.booked_at) && (
          <p className="text-xs text-green-600 mt-1">
            Booked: {format(new Date(request.booking?.starts_at || request.booked_at), 'MMM d, yyyy h:mm a')}
            {request.manual_override && <span className="ml-1 text-muted-foreground">(manual)</span>}
          </p>
        )}
      </div>
      {canOverride && (
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            setIsOverrideOpen(true);
          }}
          className="flex-shrink-0"
          data-testid={`button-override-${request.id}`}
        >
          <Settings className="w-4 h-4 mr-1" />
          Override
        </Button>
      )}
      
      <Dialog open={isOverrideOpen} onOpenChange={(open) => {
        setIsOverrideOpen(open);
        if (!open) setOverrideDateTime('');
      }}>
        <DialogContent className="max-w-sm" data-testid="manual-override-dialog" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Manual Override</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <p className="text-sm text-muted-foreground">
              Mark this meeting as booked with a specific date and time. This is for data migration purposes and will not trigger any workflow actions.
            </p>
            <div className="space-y-2">
              <Label htmlFor="override-datetime">Meeting Date & Time</Label>
              <Input
                id="override-datetime"
                type="datetime-local"
                value={overrideDateTime}
                onChange={(e) => setOverrideDateTime(e.target.value)}
                data-testid="input-override-datetime"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsOverrideOpen(false);
                  setOverrideDateTime('');
                }}
                data-testid="button-cancel-override"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleOverrideSubmit}
                disabled={!overrideDateTime || isOverriding}
                data-testid="button-confirm-override"
              >
                {isOverriding ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Check className="w-4 h-4 mr-2" />
                )}
                Mark as Booked
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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
  const { toast } = useToast();
  const queryClient = useQueryClient();

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

  const manualOverrideMutation = useMutation({
    mutationFn: async ({ meetingRequestId, overrideDateTime }) => {
      return apiRequest('POST', `/api/dd-meeting-requests/manual-override`, {
        meetingRequestId,
        overrideDateTime
      });
    },
    onSuccess: () => {
      toast({
        title: "Meeting Marked as Booked",
        description: "The meeting has been manually marked as booked.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to override meeting request.",
        variant: "destructive",
      });
    }
  });

  const handleManualOverride = (requestId, dateTime) => {
    manualOverrideMutation.mutate({ meetingRequestId: requestId, overrideDateTime: dateTime });
  };

  const requests = sentData?.requests || [];
  const configuredMeetings = configuredData?.configured_meetings || [];
  
  const isLoading = sentLoading || configuredLoading;
  const hasContent = requests.length > 0 || configuredMeetings.length > 0;

  console.log('[MeetingRequestsCard] State:', { 
    sentLoading, configuredLoading, isLoading,
    requestsCount: requests.length, 
    configuredMeetingsCount: configuredMeetings.length,
    hasContent
  });
  if (configuredData) {
    console.log('[MeetingRequestsCard] configuredData response:', JSON.stringify(configuredData, null, 2));
  }

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
                  onOverride={handleManualOverride}
                  isOverriding={manualOverrideMutation.isPending}
                  hasBookedRequest={hasBookedRequest}
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
