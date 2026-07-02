import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Calendar, Clock, Check, User, Loader2, Send, Info, Settings, UserPlus, MailCheck } from "lucide-react";
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

function MeetingRequestItem({ request, onClick, onOverride, isOverriding, hasBookedRequest, onAddAlternative, isAddingAlternative, onResend, isResending }) {
  const [isOverrideOpen, setIsOverrideOpen] = useState(false);
  const [overrideDateTime, setOverrideDateTime] = useState('');
  const [isAddAltOpen, setIsAddAltOpen] = useState(false);
  const [altFirstName, setAltFirstName] = useState('');
  const [altLastName, setAltLastName] = useState('');
  const [altEmail, setAltEmail] = useState('');
  
  const statusConfig = STATUS_CONFIG[request.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const recipientName = [request.recipient_first_name, request.recipient_last_name].filter(Boolean).join(' ') || request.recipient_email;
  const agentName = request.agent ? 
    [request.agent.first_name, request.agent.last_name].filter(Boolean).join(' ') : 'Unknown Agent';
  const canOverride = (request.status === 'pending' || request.status === 'not_sent') && !hasBookedRequest;
  const canAddAlt = request.status === 'pending' && !hasBookedRequest;
  const canResend = (request.status === 'pending' || request.status === 'not_sent') && !hasBookedRequest;
  const isBooked = request.status === 'booked';
  
  const handleOverrideSubmit = () => {
    if (!overrideDateTime) return;
    onOverride(request.id, overrideDateTime);
    setIsOverrideOpen(false);
    setOverrideDateTime('');
  };

  const handleAltSubmit = () => {
    if (!altEmail.trim()) return;
    onAddAlternative({
      meetingTemplateId: request.meeting_template_id,
      agentIdentityId: request.agent_identity_id || request.agent?.id,
      firstName: altFirstName.trim(),
      lastName: altLastName.trim(),
      email: altEmail.trim()
    });
    setAltFirstName('');
    setAltLastName('');
    setAltEmail('');
    setIsAddAltOpen(false);
  };

  const resendLabel = request.resend_count > 0 ? 'Resend' : 'Send Invite';

  return (
    <div 
      className={`flex items-start gap-3 p-3 rounded-lg border hover-elevate cursor-pointer ${isBooked ? 'border-green-500 bg-green-50' : ''}`}
      data-testid={`meeting-request-item-${request.recipient_email}`}
      onClick={onClick}
    >
      <div className="p-2 bg-muted rounded-md mt-0.5">
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
          </p>
        )}
        {request.last_resent_at && (
          <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
            <MailCheck className="w-3 h-3" />
            Last sent: {format(new Date(request.last_resent_at), 'MMM d, yyyy h:mm a')}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1 flex-shrink-0">
        {canResend && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="default"
                onClick={(e) => {
                  e.stopPropagation();
                  onResend(request.id);
                }}
                disabled={isResending}
                data-testid={`button-resend-${request.id}`}
              >
                {isResending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{resendLabel}</TooltipContent>
          </Tooltip>
        )}
        {canAddAlt && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsAddAltOpen(true);
                }}
                data-testid={`button-add-alt-${request.id}`}
              >
                <UserPlus className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add Alternative</TooltipContent>
          </Tooltip>
        )}
        {canOverride && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsOverrideOpen(true);
                }}
                data-testid={`button-override-${request.id}`}
              >
                <Settings className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Override</TooltipContent>
          </Tooltip>
        )}
      </div>
      
      <Dialog open={isAddAltOpen} onOpenChange={(open) => {
        setIsAddAltOpen(open);
        if (!open) { setAltFirstName(''); setAltLastName(''); setAltEmail(''); }
      }}>
        <DialogContent className="max-w-sm" data-testid="add-alternative-dialog" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Add Alternative Contact</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <p className="text-sm text-muted-foreground">
              Send this meeting invitation to another person. The first person to book wins.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="card-alt-first-name" className="text-xs">First Name</Label>
                <Input
                  id="card-alt-first-name"
                  value={altFirstName}
                  onChange={(e) => setAltFirstName(e.target.value)}
                  placeholder="First name"
                  data-testid="input-card-alt-first-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="card-alt-last-name" className="text-xs">Last Name</Label>
                <Input
                  id="card-alt-last-name"
                  value={altLastName}
                  onChange={(e) => setAltLastName(e.target.value)}
                  placeholder="Last name"
                  data-testid="input-card-alt-last-name"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="card-alt-email" className="text-xs">Email Address *</Label>
              <Input
                id="card-alt-email"
                type="email"
                value={altEmail}
                onChange={(e) => setAltEmail(e.target.value)}
                placeholder="email@example.com"
                data-testid="input-card-alt-email"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setIsAddAltOpen(false); setAltFirstName(''); setAltLastName(''); setAltEmail(''); }}
                data-testid="button-cancel-add-alt"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleAltSubmit}
                disabled={!altEmail.trim() || isAddingAlternative}
                data-testid="button-confirm-add-alt"
              >
                {isAddingAlternative ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <UserPlus className="w-4 h-4 mr-2" />
                )}
                Add & Send
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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

function ConfiguredMeetingItem({ config, onOverride, isOverriding, bookedTemplateIds, onSendInvite, isSendingInvite, hasBookedRequest }) {
  const [isOverrideOpen, setIsOverrideOpen] = useState(false);
  const [overrideDateTime, setOverrideDateTime] = useState('');
  const [isSendOpen, setIsSendOpen] = useState(false);
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  
  const statusConfig = STATUS_CONFIG.not_sent;
  const StatusIcon = statusConfig.icon;
  const agentNames = config.agents?.map(a => 
    [a.first_name, a.last_name].filter(Boolean).join(' ')
  ).filter(Boolean).join(', ') || 'No agents assigned';
  
  const firstAgent = config.agents?.[0];
  const templateAlreadyBooked = bookedTemplateIds?.has(config.meeting_template?.id);
  const canOverride = !templateAlreadyBooked && !hasBookedRequest && firstAgent;
  const canSendInvite = !templateAlreadyBooked && !hasBookedRequest && firstAgent;

  const handleOverrideSubmit = () => {
    if (!overrideDateTime || !firstAgent) return;
    onOverride({
      meetingTemplateId: config.meeting_template?.id,
      agentIdentityId: firstAgent.id,
      overrideDateTime
    });
    setIsOverrideOpen(false);
    setOverrideDateTime('');
  };

  const handleSendInvite = () => {
    if (!inviteEmail.trim() || !firstAgent) return;
    onSendInvite({
      meetingTemplateId: config.meeting_template?.id,
      agentIdentityId: firstAgent.id,
      firstName: inviteFirstName.trim(),
      lastName: inviteLastName.trim(),
      email: inviteEmail.trim()
    });
    setInviteFirstName('');
    setInviteLastName('');
    setInviteEmail('');
    setIsSendOpen(false);
  };
  
  return (
    <div 
      className="flex items-start gap-3 p-3 rounded-lg border bg-muted/30"
      data-testid={`configured-meeting-${config.config_id}`}
    >
      <div className="p-2 bg-muted rounded-md mt-0.5">
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
      <div className="flex flex-col gap-1 flex-shrink-0">
        {canSendInvite && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="default"
                onClick={() => setIsSendOpen(true)}
                data-testid={`button-send-invite-${config.config_id}`}
              >
                <Send className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Send Invite</TooltipContent>
          </Tooltip>
        )}
        {canOverride && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="outline"
                onClick={() => setIsOverrideOpen(true)}
                data-testid={`button-override-configured-${config.config_id}`}
              >
                <Settings className="w-4 h-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Override</TooltipContent>
          </Tooltip>
        )}
      </div>

      <Dialog open={isSendOpen} onOpenChange={(open) => {
        setIsSendOpen(open);
        if (!open) { setInviteFirstName(''); setInviteLastName(''); setInviteEmail(''); }
      }}>
        <DialogContent className="max-w-sm" data-testid="send-invite-dialog">
          <DialogHeader>
            <DialogTitle>Send Meeting Invitation</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <p className="text-sm text-muted-foreground">
              Send a meeting invitation for <span className="font-medium">{config.meeting_template?.name}</span> to a contact. They will receive a booking link.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="invite-first-name" className="text-xs">First Name</Label>
                <Input
                  id="invite-first-name"
                  value={inviteFirstName}
                  onChange={(e) => setInviteFirstName(e.target.value)}
                  placeholder="First name"
                  data-testid="input-invite-first-name"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="invite-last-name" className="text-xs">Last Name</Label>
                <Input
                  id="invite-last-name"
                  value={inviteLastName}
                  onChange={(e) => setInviteLastName(e.target.value)}
                  placeholder="Last name"
                  data-testid="input-invite-last-name"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="invite-email" className="text-xs">Email Address *</Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="email@example.com"
                data-testid="input-invite-email"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setIsSendOpen(false); setInviteFirstName(''); setInviteLastName(''); setInviteEmail(''); }}
                data-testid="button-cancel-send-invite"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSendInvite}
                disabled={!inviteEmail.trim() || isSendingInvite}
                data-testid="button-confirm-send-invite"
              >
                {isSendingInvite ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Send className="w-4 h-4 mr-2" />
                )}
                Send Invitation
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      
      <Dialog open={isOverrideOpen} onOpenChange={(open) => {
        setIsOverrideOpen(open);
        if (!open) setOverrideDateTime('');
      }}>
        <DialogContent className="max-w-sm" data-testid="configured-override-dialog">
          <DialogHeader>
            <DialogTitle>Manual Meeting Override</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <p className="text-sm text-muted-foreground">
              Enter the date and time when this meeting was held:
            </p>
            <div className="space-y-2">
              <Label htmlFor="configuredOverrideDateTime">Meeting Date & Time</Label>
              <Input
                id="configuredOverrideDateTime"
                type="datetime-local"
                value={overrideDateTime}
                onChange={(e) => setOverrideDateTime(e.target.value)}
                data-testid="input-configured-override-datetime"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button 
                variant="outline" 
                onClick={() => setIsOverrideOpen(false)}
                data-testid="button-cancel-configured-override"
              >
                Cancel
              </Button>
              <Button 
                onClick={handleOverrideSubmit}
                disabled={!overrideDateTime || isOverriding}
                data-testid="button-confirm-configured-override"
              >
                {isOverriding ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Mark as Booked'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
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

  const createBookedMutation = useMutation({
    mutationFn: async ({ meetingTemplateId, agentIdentityId, overrideDateTime }) => {
      return apiRequest('POST', `/api/dd-meeting-requests/create-booked`, {
        formSubmissionId,
        meetingTemplateId,
        agentIdentityId,
        overrideDateTime
      });
    },
    onSuccess: () => {
      toast({
        title: "Meeting Marked as Booked",
        description: "The meeting has been created and marked as booked.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId] });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/configured-by-form', formId] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create booked meeting.",
        variant: "destructive",
      });
    }
  });

  const handleConfiguredOverride = (data) => {
    createBookedMutation.mutate(data);
  };

  const addAlternativeMutation = useMutation({
    mutationFn: async ({ meetingTemplateId, agentIdentityId, firstName, lastName, email }) => {
      return apiRequest('POST', `/api/dd-meeting-requests/add-alternative`, {
        formSubmissionId,
        meetingTemplateId,
        agentIdentityId,
        recipientEmail: email,
        recipientFirstName: firstName,
        recipientLastName: lastName,
        sendImmediately: true
      });
    },
    onSuccess: () => {
      toast({
        title: "Invitation Sent",
        description: "The meeting invitation has been sent.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId] });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/configured-by-form', formId] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send meeting invitation.",
        variant: "destructive",
      });
    }
  });

  const handleAddAlternative = (data) => {
    addAlternativeMutation.mutate(data);
  };

  const resendMutation = useMutation({
    mutationFn: async (meetingRequestId) => {
      return apiRequest('POST', `/api/dd-meeting-requests/resend`, {
        meetingRequestId
      });
    },
    onSuccess: () => {
      toast({
        title: "Invitation Sent",
        description: "The meeting invitation has been sent successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to send meeting invitation.",
        variant: "destructive",
      });
    }
  });

  const handleResend = (meetingRequestId) => {
    resendMutation.mutate(meetingRequestId);
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
  const bookedTemplateIds = new Set(requests.filter(r => r.status === 'booked').map(r => r.meeting_template_id));

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
                  onOverride={handleConfiguredOverride}
                  isOverriding={createBookedMutation.isPending}
                  bookedTemplateIds={bookedTemplateIds}
                  onSendInvite={handleAddAlternative}
                  isSendingInvite={addAlternativeMutation.isPending}
                  hasBookedRequest={hasBookedRequest}
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
                  onAddAlternative={handleAddAlternative}
                  isAddingAlternative={addAlternativeMutation.isPending}
                  onResend={handleResend}
                  isResending={resendMutation.isPending}
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
