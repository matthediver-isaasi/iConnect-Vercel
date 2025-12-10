import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, MessageSquare, Bug, Lightbulb, HelpCircle, Mail, Clock, CheckCircle, AlertCircle, Upload, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
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
  in_progress: "bg-yellow-100 text-yellow-800",
  resolved: "bg-green-100 text-green-800",
  closed: "bg-slate-100 text-slate-800"
};

const priorityColors = {
  low: "bg-slate-100 text-slate-700",
  medium: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700"
};

const severityColors = {
  minor: "bg-green-100 text-green-700",
  moderate: "bg-yellow-100 text-yellow-700",
  major: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700"
};

export default function SupportPage() {
  const { memberInfo } = useMemberAccess();
  const [showNewTicket, setShowNewTicket] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [newTicket, setNewTicket] = useState({
    type: "general",
    subject: "",
    description: "",
    severity: "moderate",
    attachments: []
  });
  const [replyMessage, setReplyMessage] = useState("");
  const [uploadingFile, setUploadingFile] = useState(false);

  const queryClient = useQueryClient();

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

  const createTicketMutation = useMutation({
    mutationFn: (ticketData) => base44.entities.SupportTicket.create(ticketData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-tickets'] });
      toast.success('Support ticket submitted successfully');
      setShowNewTicket(false);
      setNewTicket({ type: "general", subject: "", description: "", severity: "moderate", attachments: [] });
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
      toast.error('Failed to upload file');
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

  if (!memberInfo) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <div className="animate-pulse text-slate-600">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Support</h1>
            <p className="text-slate-600">Submit bug reports, feature requests, or ask questions</p>
          </div>
          <Button onClick={() => setShowNewTicket(true)} className="bg-blue-600 hover:bg-blue-700">
            <Plus className="w-4 h-4 mr-2" />
            New Ticket
          </Button>
        </div>

        {isLoading ? (
          <div className="text-center py-12">Loading tickets...</div>
        ) : tickets.length === 0 ? (
          <Card className="border-slate-200 shadow-sm">
            <CardContent className="p-12 text-center">
              <MessageSquare className="w-16 h-16 text-slate-300 mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-slate-900 mb-2">No Support Tickets Yet</h3>
              <p className="text-slate-600 mb-6">Submit your first ticket to get help from our team</p>
              <Button onClick={() => setShowNewTicket(true)} className="bg-blue-600 hover:bg-blue-700">
                <Plus className="w-4 h-4 mr-2" />
                Create First Ticket
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tickets.map((ticket) => {
              const TypeIcon = typeIcons[ticket.type];
              return (
                <Card
                  key={ticket.id}
                  className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setSelectedTicket(ticket)}
                >
                  <CardHeader className="border-b border-slate-200">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <TypeIcon className="w-5 h-5 text-blue-600" />
                        <Badge variant="outline" className="text-xs">
                          {typeLabels[ticket.type]}
                        </Badge>
                      </div>
                      <Badge className={statusColors[ticket.status]}>
                        {ticket.status.replace('_', ' ')}
                      </Badge>
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
                          <Badge className={severityColors[ticket.severity]} variant="outline">
                            {ticket.severity}
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
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minor">Minor</SelectItem>
                      <SelectItem value="moderate">Moderate</SelectItem>
                      <SelectItem value="major">Major</SelectItem>
                      <SelectItem value="critical">Critical</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
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
                          className="h-6 w-6"
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
                          <Badge className={severityColors[selectedTicket.severity]}>
                            {selectedTicket.severity}
                          </Badge>
                        )}
                      </div>
                      <DialogTitle className="text-2xl">{selectedTicket.subject}</DialogTitle>
                      <p className="text-sm text-slate-500 mt-2">
                        Submitted {format(new Date(selectedTicket.created_date), 'MMM d, yyyy h:mm a')}
                      </p>
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
      </div>
    </div>
  );
}