import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Calendar, Check, Clock, User, AlertCircle, Send, Loader2, UserPlus, CheckCircle2, ExternalLink
} from "lucide-react";
import { format } from 'date-fns';
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: '#f59e0b', bgColor: '#fef3c7', icon: Clock },
  booked: { label: 'Booked', color: '#22c55e', bgColor: '#dcfce7', icon: Check },
  cancelled: { label: 'Cancelled', color: '#6b7280', bgColor: '#f3f4f6', icon: Clock },
  expired: { label: 'Expired', color: '#ef4444', bgColor: '#fee2e2', icon: AlertCircle }
};

function RequestRow({ request, onResend, isResending, hasBookedRequest }) {
  const statusConfig = STATUS_CONFIG[request.status] || STATUS_CONFIG.pending;
  const StatusIcon = statusConfig.icon;
  const recipientName = [request.recipient_first_name, request.recipient_last_name].filter(Boolean).join(' ') || 'Unknown';
  const isBooked = request.status === 'booked';
  const canResend = request.status === 'pending' && !hasBookedRequest;
  
  return (
    <div 
      className={`flex items-center gap-3 p-3 rounded-lg border ${isBooked ? 'border-green-500 bg-green-50' : ''}`}
      data-testid={`request-row-${request.recipient_email}`}
    >
      <div className="p-2 bg-muted rounded-md flex-shrink-0">
        <User className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{recipientName}</p>
          {request.is_original && (
            <Badge variant="secondary" className="text-xs flex-shrink-0">Original</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{request.recipient_email}</p>
        {request.agent && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Host: {[request.agent.first_name, request.agent.last_name].filter(Boolean).join(' ')}
          </p>
        )}
        {request.sent_at && (
          <p className="text-xs text-muted-foreground">
            Sent: {format(new Date(request.sent_at), 'MMM d, yyyy h:mm a')}
            {request.resend_count > 0 && ` (resent ${request.resend_count}x)`}
          </p>
        )}
        {request.booking && (
          <p className="text-xs text-green-600 mt-1">
            Booked: {format(new Date(request.booking.starts_at), 'MMM d, yyyy h:mm a')}
          </p>
        )}
      </div>
      <Badge 
        variant="outline" 
        className="flex-shrink-0 text-xs"
        style={{ borderColor: statusConfig.color, color: statusConfig.color }}
      >
        <StatusIcon className="w-3 h-3 mr-1" />
        {statusConfig.label}
      </Badge>
      {canResend && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onResend(request.id)}
          disabled={isResending}
          className="flex-shrink-0"
          data-testid={`button-resend-${request.id}`}
        >
          {isResending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <>
              <Send className="w-4 h-4 mr-1" />
              Resend
            </>
          )}
        </Button>
      )}
      {isBooked && (
        <Badge className="flex-shrink-0 bg-green-100 text-green-700 border-green-300">
          <CheckCircle2 className="w-3 h-3 mr-1" />
          Winner
        </Badge>
      )}
      {request.booking_url && request.status === 'pending' && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => window.open(request.booking_url, '_blank')}
          title="Open booking page"
          data-testid={`button-open-booking-${request.id}`}
        >
          <ExternalLink className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
}

function AddAlternativeRequestForm({ 
  onSubmit, 
  isSubmitting, 
  isDisabled, 
  meetingTemplates, 
  agents,
  currentTemplateId
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState(currentTemplateId || '');
  const [selectedAgentId, setSelectedAgentId] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!email.trim() || !selectedTemplateId || !selectedAgentId) return;
    onSubmit({ 
      firstName: firstName.trim(), 
      lastName: lastName.trim(), 
      email: email.trim(),
      meetingTemplateId: selectedTemplateId,
      agentIdentityId: selectedAgentId
    });
    setFirstName('');
    setLastName('');
    setEmail('');
  };

  if (isDisabled) {
    return (
      <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-center">
        <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
        <p className="text-sm font-medium text-green-700">A meeting has been booked</p>
        <p className="text-xs text-green-600 mt-1">No additional requests can be added</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="p-4 bg-muted/50 rounded-lg space-y-4">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        <UserPlus className="w-4 h-4" />
        Add Alternative Meeting Request
      </h4>
      <p className="text-xs text-muted-foreground">
        Add another person who can book this meeting. The first to book wins.
      </p>
      
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="alt-first-name" className="text-xs">First Name</Label>
          <Input
            id="alt-first-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            placeholder="First name"
            data-testid="input-alt-first-name"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="alt-last-name" className="text-xs">Last Name</Label>
          <Input
            id="alt-last-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            placeholder="Last name"
            data-testid="input-alt-last-name"
          />
        </div>
      </div>
      
      <div className="space-y-1">
        <Label htmlFor="alt-email" className="text-xs">Email Address *</Label>
        <Input
          id="alt-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@example.com"
          required
          data-testid="input-alt-email"
        />
      </div>

      {meetingTemplates && meetingTemplates.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="meeting-template" className="text-xs">Meeting Type *</Label>
          <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
            <SelectTrigger data-testid="select-meeting-template">
              <SelectValue placeholder="Select meeting type" />
            </SelectTrigger>
            <SelectContent>
              {meetingTemplates.map(t => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {agents && agents.length > 0 && (
        <div className="space-y-1">
          <Label htmlFor="agent" className="text-xs">Host (Agent) *</Label>
          <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
            <SelectTrigger data-testid="select-agent">
              <SelectValue placeholder="Select host" />
            </SelectTrigger>
            <SelectContent>
              {agents.map(a => (
                <SelectItem key={a.id} value={a.id}>
                  {[a.first_name, a.last_name].filter(Boolean).join(' ') || a.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={isSubmitting || !email.trim() || !selectedTemplateId || !selectedAgentId}
          data-testid="button-add-alt-request"
        >
          {isSubmitting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <UserPlus className="w-4 h-4 mr-2" />
          )}
          Add & Send
        </Button>
      </div>
    </form>
  );
}

export default function MeetingRequestDetailModal({ 
  isOpen, 
  onClose, 
  request,
  allRequests = [],
  hasBookedRequest = false,
  formSubmissionId
}) {
  const [resendingId, setResendingId] = useState(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: templatesData } = useQuery({
    queryKey: ['/api/entities/meeting_template'],
    enabled: isOpen && !hasBookedRequest
  });

  const { data: agentsData } = useQuery({
    queryKey: ['/api/booking-agents'],
    enabled: isOpen && !hasBookedRequest
  });

  const resendMutation = useMutation({
    mutationFn: async (meetingRequestId) => {
      return apiRequest('POST', `/api/dd-meeting-requests/resend`, {
        meetingRequestId
      });
    },
    onSuccess: () => {
      toast({
        title: "Meeting Invitation Resent",
        description: "The meeting invitation has been resent.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId] });
      setResendingId(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to resend invitation.",
        variant: "destructive",
      });
      setResendingId(null);
    }
  });

  const addAlternativeMutation = useMutation({
    mutationFn: async (data) => {
      return apiRequest('POST', `/api/dd-meeting-requests/add-alternative`, {
        formSubmissionId,
        meetingTemplateId: data.meetingTemplateId,
        agentIdentityId: data.agentIdentityId,
        recipientEmail: data.email,
        recipientFirstName: data.firstName,
        recipientLastName: data.lastName,
        sendImmediately: true
      });
    },
    onSuccess: () => {
      toast({
        title: "Request Added",
        description: "The alternative meeting request has been sent.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/dd-meeting-requests/by-submission', formSubmissionId] });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message || "Failed to add request.",
        variant: "destructive",
      });
    }
  });

  const handleResend = (id) => {
    setResendingId(id);
    resendMutation.mutate(id);
  };

  const handleAddAlternative = (data) => {
    addAlternativeMutation.mutate(data);
  };

  if (!request) return null;

  const statusConfig = STATUS_CONFIG[request.status] || STATUS_CONFIG.pending;
  const templateName = request.meeting_template?.name || 'Meeting';
  
  const relatedRequests = allRequests.filter(r => 
    r.meeting_template_id === request.meeting_template_id
  );

  const meetingTemplates = templatesData || [];
  const agents = agentsData?.agents || [];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col" data-testid="meeting-request-detail-modal">
        <DialogHeader className="flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-muted rounded-md">
              <Calendar className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-lg truncate">{templateName}</DialogTitle>
              <p className="text-sm text-muted-foreground truncate">
                {request.meeting_template?.duration_minutes} minutes - {request.meeting_template?.meeting_type}
              </p>
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 mt-4">
          <div className="space-y-4 pr-4">
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <User className="w-4 h-4" />
                Meeting Requests
              </h3>
              <p className="text-xs text-muted-foreground mb-3">
                The first person to book wins. All others will no longer be able to book.
              </p>
              
              {relatedRequests.length > 0 ? (
                <div className="space-y-2">
                  {relatedRequests.map((req) => (
                    <RequestRow 
                      key={req.id}
                      request={req}
                      onResend={handleResend}
                      isResending={resendingId === req.id}
                      hasBookedRequest={hasBookedRequest}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground border rounded-lg">
                  <Calendar className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No requests sent yet</p>
                </div>
              )}
            </div>

            <Separator />

            <AddAlternativeRequestForm 
              onSubmit={handleAddAlternative}
              isSubmitting={addAlternativeMutation.isPending}
              isDisabled={hasBookedRequest}
              meetingTemplates={meetingTemplates}
              agents={agents}
              currentTemplateId={request.meeting_template_id}
            />
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
