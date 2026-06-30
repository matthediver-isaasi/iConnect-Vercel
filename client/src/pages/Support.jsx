import React, { useState, useMemo, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import {
  resolveSupportLevels,
  resolveSupportInstructions,
  getDefaultSeverity,
  getSeverityLabel,
  getSeverityBadgeClass,
} from "@/lib/supportLevels";
import {
  resolveSupportAreas,
  getAreaLabel,
  AREA_BADGE_CLASS,
} from "@/lib/supportAreas";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, MessageSquare, Bug, Lightbulb, HelpCircle, Mail, Clock, CheckCircle, AlertCircle, Upload, X, Loader2, Bell } from "lucide-react";
import { toast } from "sonner";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { format, formatDistanceToNow } from "date-fns";
import { useMemberAccess } from "@/hooks/useMemberAccess";

const typeIcons = {
  bug: Bug,
  feature_request: Lightbulb,
  how_to: HelpCircle,
  general: Mail
};

const typeLabels = {
  bug: "Bug Report",
  feature_request: "Feature Request",
  how_to: "How-To Question",
  general: "General Message"
};

const statusColors = {
  open: "bg-blue-100 text-blue-800",
  in_progress: "bg-warning/10 text-warning",
  resolved: "bg-green-100 text-green-800",
  closed: "bg-slate-100 text-slate-800"
};

const priorityColors = {
  low: "bg-slate-100 text-slate-700",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-warning/10 text-warning",
  urgent: "bg-red-100 text-red-700"
};

function formatRelative(dateString) {
  if (!dateString) return "";
  try {
    return formatDistanceToNow(new Date(dateString), { addSuffix: true });
  } catch {
    return "";
  }
}

export default function SupportPage() {
  const { memberInfo } = useMemberAccess();
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [newTicket, setNewTicket] = useState({
    type: "general",
    subject: "",
    description: "",
    severity: "moderate",
    area: "",
    attachments: []
  });
  const [replyMessage, setReplyMessage] = useState("");
  const [uploadingFile, setUploadingFile] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);

  const queryClient = useQueryClient();

  const { data: supportSettings = [] } = useQuery({
    queryKey: ['public-support-settings'],
    queryFn: () => publicClient.listSystemSettings(),
    staleTime: 30000,
  });

  const supportLevels = useMemo(() => resolveSupportLevels(supportSettings), [supportSettings]);
  const supportAreas = useMemo(() => resolveSupportAreas(supportSettings), [supportSettings]);
  const supportInstructions = useMemo(() => resolveSupportInstructions(supportSettings), [supportSettings]);
  const defaultSeverity = useMemo(() => getDefaultSeverity(supportLevels), [supportLevels]);

  const openNewTicket = () => {
    setNewTicket({ type: "general", subject: "", description: "", severity: defaultSeverity, area: "", attachments: [] });
    setShowNewTicket(true);
  };

  // If the modal is opened before tenant support settings finish loading, sync the
  // pre-selected severity to the tenant default once it resolves (unless the user
  // already picked a value that exists in the configured levels).
  useEffect(() => {
    if (!showNewTicket) return;
    const isValid = supportLevels.some((lvl) => lvl.value === newTicket.severity);
    if (!isValid && newTicket.severity !== defaultSeverity) {
      setNewTicket((prev) => ({ ...prev, severity: defaultSeverity }));
    }
  }, [showNewTicket, supportLevels, defaultSeverity]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['support-tickets', memberInfo?.email],
    queryFn: async () => {
      const allTickets = await base44.entities.SupportTicket.list("-created_date");
      return allTickets.filter(t => t.submitter_email === memberInfo?.email);
    },
    enabled: !!memberInfo
  });

  const { data: responses = [] } = useQuery({
    queryKey: ['support-responses', selectedTicket?.id],
    queryFn: async () => {
      const allResponses = await base44.entities.SupportTicketResponse.list("created_date");
      return allResponses.filter(r => r.ticket_id === selectedTicket?.id);
    },
    enabled: !!selectedTicket
  });

  // Inbox: admin_reply notifications for the submitter
  const { data: inboxData = { items: [], unread_count: 0 }, isLoading: inboxLoading } = useQuery({
    queryKey: ['support-inbox'],
    queryFn: async () => {
      const res = await fetch('/api/support/inbox', { credentials: 'include' });
      if (!res.ok) return { items: [], unread_count: 0 };
      const data = await res.json();
      // Submitter sees only admin_reply items on their own tickets
      const myTicketIds = new Set(tickets.map(t => t.id));
      const filtered = (data.items || []).filter(
        item => item.event_type === 'admin_reply' && myTicketIds.has(item.ticket_id)
      );
      const unread_count = filtered.filter(item => !item.read_at).length;
      return { items: filtered, unread_count };
    },
    enabled: !!memberInfo && tickets.length > 0,
    refetchInterval: 60000,
  });

  const markReadMutation = useMutation({
    mutationFn: async ({ item_ids, mark_all_read }) => {
      const res = await fetch('/api/support/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(item_ids ? { item_ids } : { mark_all_read: true }),
      });
      if (!res.ok) throw new Error('Failed to mark as read');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-inbox'] });
    },
  });

  const createTicketMutation = useMutation({
    mutationFn: (ticketData) => base44.entities.SupportTicket.create(ticketData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success('Support ticket submitted successfully');
      setShowNewTicket(false);
      setNewTicket({ type: "general", subject: "", description: "", severity: defaultSeverity, area: "", attachments: [] });
    },
    onError: () => toast.error('Failed to submit ticket')
  });

  const addResponseMutation = useMutation({
    mutationFn: (responseData) => base44.entities.SupportTicketResponse.create(responseData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-responses'] });
      toast.success('Reply added');
      setReplyMessage("");
    },
    onError: () => toast.error('Failed to add reply')
  });

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingFile(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setNewTicket({ ...newTicket, attachments: [...newTicket.attachments, file_url] });
      toast.success('File uploaded');
    } catch (error) {
      showUploadErrorToast(error, 'Failed to upload file');
    } finally {
      setUploadingFile(false);
    }
  };

  const handleRemoveAttachment = (index) => {
    setNewTicket({
      ...newTicket,
      attachments: newTicket.attachments.filter((_, i) => i !== index)
    });
  };

  const handleCreateTicket = () => {
    if (!newTicket.subject.trim() || !newTicket.description.trim()) {
      toast.error('Please fill in all fields');
      return;
    }

    createTicketMutation.mutate({
      ...newTicket,
      submitter_email: memberInfo.email,
      submitter_name: `${memberInfo.first_name} ${memberInfo.last_name}`
    });
  };

  const handleAddReply = () => {
    if (!replyMessage.trim()) return;

    addResponseMutation.mutate({
      ticket_id: selectedTicket.id,
      message: replyMessage,
      is_admin_response: false,
      responder_email: memberInfo.email,
      responder_name: `${memberInfo.first_name} ${memberInfo.last_name}`
    });
  };

  const handleInboxItemClick = (item) => {
    if (!item.read_at) {
      markReadMutation.mutate({ item_ids: [item.id] });
    }
    const ticket = tickets.find(t => t.id === item.ticket_id);
    if (ticket) {
      setSelectedTicket(ticket);
      setInboxOpen(false);
    }
  };

  if (!memberInfo) {
    return (
      <div className="min-h-screen p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  const unreadCount = inboxData.unread_count || 0;
  const inboxItems = inboxData.items || [];

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Support</h1>
            <p className="text-slate-600">Submit bug reports, feature requests, or ask questions</p>
          </div>
          <div className="flex items-center gap-3">
            {tickets.length > 0 && (
              <Button
                variant="outline"
                className="relative"
                onClick={() => setInboxOpen(true)}
                data-testid="button-support-inbox"
              >
                <Bell className="w-4 h-4 mr-2" />
                Updates
                {unreadCount > 0 && (
                  <span
                    className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-blue-600 text-white text-xs font-bold"
                    data-testid="text-unread-count"
                  >
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </Button>
            )}
            <Button onClick={openNewTicket} className="bg-blue-600 hover:bg-blue-700">
              <Plus className="w-4 h-4 mr-2" />
              New Ticket
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="text-center py-12">Loading tickets...</div>
        ) : tickets.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <MessageSquare className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Support Tickets Yet</h3>
              <p className="text-slate-600 mb-6">Submit your first ticket to get help from our team</p>
              <Button onClick={openNewTicket} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Ticket
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tickets.map((ticket) => {
              const TypeIcon = typeIcons[ticket.type];
              // Count unread admin replies for this ticket
              const ticketUnread = inboxItems.filter(i => i.ticket_id === ticket.id && !i.read_at).length;
              return (
                <Card
                  key={ticket.id}
                  className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setSelectedTicket(ticket)}
                  data-testid={`card-ticket-${ticket.id}`}
                >
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <TypeIcon className="w-5 h-5 text-blue-600" />
                        <Badge variant="outline" className="text-xs">
                          {typeLabels[ticket.type]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={statusColors[ticket.status]}>
                          {ticket.status.replace('_', ' ')}
                        </Badge>
                        {ticketUnread > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-blue-600 text-white text-xs font-bold" data-testid={`unread-badge-${ticket.id}`}>
                            {ticketUnread}
                          </span>
                        )}
                      </div>
                    </div>
                    <CardTitle className="text-lg">{ticket.subject}</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <p className="text-sm text-slate-600 mb-4 line-clamp-2">{ticket.description}</p>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <div className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {format(new Date(ticket.created_date), 'MMM d, yyyy')}
                      </div>
                      <div className="flex items-center gap-2">
                        {ticket.severity && (
                          <Badge className={getSeverityBadgeClass(ticket.severity)} variant="outline">
                            {getSeverityLabel(supportLevels, ticket.severity)}
                          </Badge>
                        )}
                        {ticket.area && (
                          <Badge className={AREA_BADGE_CLASS} data-testid={`badge-area-${ticket.id}`}>
                            {getAreaLabel(supportAreas, ticket.area)}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* New Ticket Dialog */}
        <Dialog open={showNewTicket} onOpenChange={setShowNewTicket}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create Support Ticket</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {supportInstructions && (
                <div
                  className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 whitespace-pre-wrap"
                  data-testid="text-support-instructions"
                >
                  {supportInstructions}
                </div>
              )}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={newTicket.type} onValueChange={(value) => setNewTicket({ ...newTicket, type: value })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bug">Bug Report</SelectItem>
                      <SelectItem value="feature_request">Feature Request</SelectItem>
                      <SelectItem value="how_to">How-To Question</SelectItem>
                      <SelectItem value="general">General Message</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Severity</Label>
                  <Select value={newTicket.severity} onValueChange={(value) => setNewTicket({ ...newTicket, severity: value })}>
                    <SelectTrigger data-testid="select-severity">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {supportLevels.map((level) => (
                        <SelectItem key={level.value} value={level.value}>{level.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {supportAreas.length > 0 && (
                <div className="space-y-2">
                  <Label>Area</Label>
                  <Select value={newTicket.area || "none"} onValueChange={(value) => setNewTicket({ ...newTicket, area: value === "none" ? "" : value })}>
                    <SelectTrigger data-testid="select-area">
                      <SelectValue placeholder="Select area (optional)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No specific area</SelectItem>
                      {supportAreas.map((area) => (
                        <SelectItem key={area.value} value={area.value}>{area.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input
                  placeholder="Brief description of your issue or request..."
                  value={newTicket.subject}
                  onChange={(e) => setNewTicket({ ...newTicket, subject: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  placeholder="Provide detailed information..."
                  rows={6}
                  value={newTicket.description}
                  onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Attachments</Label>
                {newTicket.attachments.length > 0 && (
                  <div className="space-y-2 mb-3">
                    {newTicket.attachments.map((url, index) => (
                      <div key={index} className="flex items-center gap-2 p-2 bg-slate-50 rounded border">
                        <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-blue-600 hover:underline flex-1 truncate">
                          {url.split('/').pop()}
                        </a>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleRemoveAttachment(index)}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                <label className="block">
                  <input
                    type="file"
                    onChange={handleFileUpload}
                    className="hidden"
                    disabled={uploadingFile}
                  />
                  <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center cursor-pointer hover:border-slate-400 transition-colors">
                    {uploadingFile ? (
                      <>
                        <Loader2 className="w-6 h-6 text-slate-400 mx-auto mb-2 animate-spin" />
                        <p className="text-sm text-slate-600">Uploading...</p>
                      </>
                    ) : (
                      <>
                        <Upload className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                        <p className="text-sm text-slate-600">Click to upload file or image</p>
                      </>
                    )}
                  </div>
                </label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowNewTicket(false)}>Cancel</Button>
              <Button
                onClick={handleCreateTicket}
                disabled={createTicketMutation.isPending}
                className="bg-blue-600 hover:bg-blue-700"
              >
                Submit Ticket
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* View Ticket Dialog */}
        <Dialog open={!!selectedTicket} onOpenChange={() => setSelectedTicket(null)}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            {selectedTicket && (
              <>
                <DialogHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        {React.createElement(typeIcons[selectedTicket.type], { className: "w-5 h-5 text-blue-600" })}
                        <Badge variant="outline">{typeLabels[selectedTicket.type]}</Badge>
                        <Badge className={statusColors[selectedTicket.status]}>
                          {selectedTicket.status.replace('_', ' ')}
                        </Badge>
                        {selectedTicket.severity && (
                          <Badge className={getSeverityBadgeClass(selectedTicket.severity)}>
                            {getSeverityLabel(supportLevels, selectedTicket.severity)}
                          </Badge>
                        )}
                        {selectedTicket.area && (
                          <Badge className={AREA_BADGE_CLASS}>
                            {getAreaLabel(supportAreas, selectedTicket.area)}
                          </Badge>
                        )}
                      </div>
                      <DialogTitle className="text-2xl">{selectedTicket.subject}</DialogTitle>
                      <div className="mt-2 space-y-1">
                        <p className="text-sm text-slate-500">
                          Submitted {format(new Date(selectedTicket.created_date), 'MMM d, yyyy h:mm a')}
                        </p>
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">By:</span> {selectedTicket.submitter_name || 'Unknown'} 
                          {selectedTicket.submitter_email && (
                            <span className="text-slate-500"> ({selectedTicket.submitter_email})</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                </DialogHeader>

                <div className="space-y-6">
                  {/* Original Description */}
                  <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                    <p className="text-sm text-slate-700 whitespace-pre-wrap">{selectedTicket.description}</p>
                  </div>

                  {/* Attachments */}
                  {selectedTicket.attachments && selectedTicket.attachments.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="font-semibold text-slate-900 text-sm">Attachments</h3>
                      <div className="grid md:grid-cols-2 gap-2">
                        {selectedTicket.attachments.map((url, index) => (
                          <a
                            key={index}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 p-3 bg-slate-50 rounded border border-slate-200 hover:bg-slate-100 transition-colors"
                          >
                            <Upload className="w-4 h-4 text-slate-400" />
                            <span className="text-sm text-blue-600 hover:underline truncate">
                              {url.split('/').pop()}
                            </span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Resolution Notes */}
                  {selectedTicket.resolution_notes && (
                    <div className="bg-green-50 rounded-lg p-4 border border-green-200">
                      <div className="flex items-center gap-2 mb-2">
                        <CheckCircle className="w-4 h-4 text-green-600" />
                        <span className="font-semibold text-green-900">Resolution</span>
                      </div>
                      <p className="text-sm text-green-700">{selectedTicket.resolution_notes}</p>
                    </div>
                  )}

                  {/* Conversation Thread */}
                  {responses.length > 0 && (
                    <div className="space-y-4">
                      <h3 className="font-semibold text-slate-900">Conversation</h3>
                      {responses.map((response) => (
                        <div
                          key={response.id}
                          className={`rounded-lg p-4 ${
                            response.is_admin_response
                              ? 'bg-blue-50 border border-blue-200'
                              : 'bg-slate-50 border border-slate-200'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-sm text-slate-900">
                              {response.responder_name}
                              {response.is_admin_response && (
                                <Badge className="ml-2 bg-blue-600 text-white">Developer</Badge>
                              )}
                            </span>
                            <span className="text-xs text-slate-500">
                              {format(new Date(response.created_date), 'MMM d, h:mm a')}
                            </span>
                          </div>
                          <p className="text-sm text-slate-700 whitespace-pre-wrap">{response.message}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reply Section (only if not closed) */}
                  {selectedTicket.status !== 'closed' && (
                    <div className="space-y-2">
                      <Label>Add Reply</Label>
                      <Textarea
                        placeholder="Type your reply..."
                        rows={4}
                        value={replyMessage}
                        onChange={(e) => setReplyMessage(e.target.value)}
                      />
                      <div className="flex justify-end">
                        <Button
                          onClick={handleAddReply}
                          disabled={addResponseMutation.isPending || !replyMessage.trim()}
                          className="bg-blue-600 hover:bg-blue-700"
                        >
                          Send Reply
                        </Button>
                      </div>
                    </div>
                  )}

                  {selectedTicket.status === 'closed' && (
                    <div className="flex items-center gap-2 text-sm text-slate-600 bg-slate-100 p-3 rounded-lg">
                      <AlertCircle className="w-4 h-4" />
                      This ticket is closed. Contact support if you need to reopen it.
                    </div>
                  )}
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>

        {/* Submitter Inbox — admin reply notifications */}
        <Sheet open={inboxOpen} onOpenChange={setInboxOpen}>
          <SheetContent className="w-full sm:max-w-md flex flex-col">
            <SheetHeader className="flex-shrink-0">
              <div className="flex items-center justify-between gap-2">
                <SheetTitle className="flex items-center gap-2">
                  <Bell className="w-5 h-5" />
                  Ticket Updates
                  {unreadCount > 0 && (
                    <Badge className="bg-blue-600 text-white" data-testid="text-inbox-unread-badge">
                      {unreadCount}
                    </Badge>
                  )}
                </SheetTitle>
                {unreadCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => markReadMutation.mutate({ mark_all_read: true })}
                    disabled={markReadMutation.isPending}
                    data-testid="button-mark-all-read"
                  >
                    Mark all read
                  </Button>
                )}
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-hidden mt-4">
              {inboxLoading ? (
                <div className="space-y-3 p-1">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-start gap-3 p-3 rounded-md border">
                      <Skeleton className="w-8 h-8 rounded-md flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-3/4" />
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : inboxItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center px-4">
                  <Bell className="w-10 h-10 text-slate-300 mb-3" />
                  <p className="text-sm text-muted-foreground">No updates yet</p>
                  <p className="text-xs text-muted-foreground mt-1">You'll be notified here when someone replies to your tickets</p>
                </div>
              ) : (
                <ScrollArea className="h-full pr-1">
                  <div className="flex flex-col gap-2">
                    {inboxItems.map(item => {
                      const isUnread = !item.read_at;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => handleInboxItemClick(item)}
                          className={`w-full text-left flex items-start gap-3 p-3 rounded-md border hover-elevate transition-colors ${
                            isUnread ? 'bg-primary/5 border-primary/30' : 'bg-background'
                          }`}
                          data-testid={`inbox-item-${item.id}`}
                        >
                          <div className="mt-0.5 flex-shrink-0">
                            <MessageSquare className={`w-4 h-4 ${isUnread ? 'text-primary' : 'text-muted-foreground'}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className={`text-sm truncate ${isUnread ? 'font-semibold' : 'font-medium'}`}>
                                {item.ticket_subject || item.metadata?.ticket_subject || 'Your ticket'}
                              </span>
                              {isUnread && (
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" aria-label="Unread" />
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">The support team replied to your ticket</div>
                            {item.metadata?.reply_excerpt && (
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                                {item.metadata.reply_excerpt}
                              </p>
                            )}
                            <div className="text-xs text-muted-foreground/70 mt-1">
                              {formatRelative(item.created_at)}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
