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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Bug, Lightbulb, HelpCircle, Mail, Search, Clock, CheckCircle, Upload, Loader2 } from "lucide-react";
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

export default function SupportManagementPage() {
  const { isAdmin, memberInfo, isAccessReady } = useMemberAccess();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [replyMessage, setReplyMessage] = useState("");
  const [updateData, setUpdateData] = useState({});
  const [uploadingImages, setUploadingImages] = useState(false);
  const [responseAttachments, setResponseAttachments] = useState([]);

  const queryClient = useQueryClient();

  const hasAccess = memberInfo?.email?.includes('isaasi.co.uk') || memberInfo?.email === 'sharon@onlinem.co.uk';

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ['all-support-tickets'],
    queryFn: () => base44.entities.SupportTicket.list("-created_date"),
    enabled: hasAccess && isAccessReady
  });

  const { data: responses = [] } = useQuery({
    queryKey: ['support-responses', selectedTicket?.id],
    queryFn: async () => {
      const allResponses = await base44.entities.SupportTicketResponse.list("created_date");
      return allResponses.filter(r => r.ticket_id === selectedTicket?.id);
    },
    enabled: !!selectedTicket
  });

  const updateTicketMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities.SupportTicket.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-support-tickets'] });
      toast.success('Ticket updated');
    },
    onError: () => toast.error('Failed to update ticket')
  });

  const addResponseMutation = useMutation({
    mutationFn: (responseData) => base44.entities.SupportTicketResponse.create(responseData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['support-responses'] });
      toast.success('Response added');
      setReplyMessage("");
      setResponseAttachments([]);
    },
    onError: () => toast.error('Failed to add response')
  });

  if (!isAccessReady) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const handleUpdateTicket = (updates) => {
    updateTicketMutation.mutate({
      id: selectedTicket.id,
      data: updates
    });
    setSelectedTicket({ ...selectedTicket, ...updates });
  };

  const handleAddResponse = () => {
    if (!replyMessage.trim()) return;

    addResponseMutation.mutate({
      ticket_id: selectedTicket.id,
      message: replyMessage,
      is_admin_response: true,
      responder_email: memberInfo.email,
      responder_name: `${memberInfo.first_name} ${memberInfo.last_name}`,
      attachments: responseAttachments
    });
  };

  const handleImageUpload = async (files) => {
    if (!files || files.length === 0) return;

    setUploadingImages(true);
    try {
      const uploadPromises = Array.from(files).map(async (file) => {
        const response = await base44.integrations.Core.UploadFile({ file });
        return response.file_url;
      });
      
      const urls = await Promise.all(uploadPromises);
      setResponseAttachments(prev => [...prev, ...urls]);
      toast.success(`Uploaded ${urls.length} image(s)`);
    } catch (error) {
      toast.error('Failed to upload images: ' + error.message);
    } finally {
      setUploadingImages(false);
    }
  };

  const handleRemoveAttachment = (url) => {
    setResponseAttachments(prev => prev.filter(u => u !== url));
  };

  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8 flex items-center justify-center">
        <Card className="border-red-200">
          <CardContent className="p-8 text-center">
            <p className="text-red-600">Access restricted to isaasi.co.uk team members</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const filteredTickets = tickets.filter(ticket => {
    const matchesSearch = ticket.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         ticket.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         ticket.submitter_name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus = statusFilter === "all" || ticket.status === statusFilter;
    const matchesType = typeFilter === "all" || ticket.type === typeFilter;
    return matchesSearch && matchesStatus && matchesType;
  });

  const getTicketCounts = (status) => {
    return tickets.filter(t => t.status === status).length;
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-2">Support Management</h1>
          <p className="text-slate-600">Manage and respond to support tickets</p>
        </div>

        {/* Stats */}
        <div className="grid md:grid-cols-4 gap-4 mb-6">
          <Card className="border-blue-200">
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-blue-600">{getTicketCounts('open')}</div>
              <div className="text-sm text-slate-600">Open</div>
            </CardContent>
          </Card>
          <Card className="border-yellow-200">
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-yellow-600">{getTicketCounts('in_progress')}</div>
              <div className="text-sm text-slate-600">In Progress</div>
            </CardContent>
          </Card>
          <Card className="border-green-200">
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-green-600">{getTicketCounts('resolved')}</div>
              <div className="text-sm text-slate-600">Resolved</div>
            </CardContent>
          </Card>
          <Card className="border-slate-200">
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-slate-600">{getTicketCounts('closed')}</div>
              <div className="text-sm text-slate-600">Closed</div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card className="border-slate-200 shadow-sm mb-6">
          <CardContent className="p-4">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-slate-400" />
                <Input
                  placeholder="Search tickets..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full md:w-48">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-full md:w-48">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="bug">Bug Report</SelectItem>
                  <SelectItem value="feature_request">Feature Request</SelectItem>
                  <SelectItem value="how_to">How-To Question</SelectItem>
                  <SelectItem value="general">General Message</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Tickets List */}
        {isLoading ? (
          <div className="text-center py-12">Loading tickets...</div>
        ) : filteredTickets.length === 0 ? (
          <Card className="border-slate-200">
            <CardContent className="p-12 text-center">
              <p className="text-slate-600">No tickets found</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {filteredTickets.map((ticket) => {
              const TypeIcon = typeIcons[ticket.type];
              return (
                <Card
                  key={ticket.id}
                  className="border-slate-200 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setSelectedTicket(ticket)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2 flex-wrap">
                          <TypeIcon className="w-5 h-5 text-blue-600" />
                          <Badge variant="outline" className="text-xs">{typeLabels[ticket.type]}</Badge>
                          <Badge className={statusColors[ticket.status]}>{ticket.status.replace('_', ' ')}</Badge>
                          {ticket.severity && (
                            <Badge className={severityColors[ticket.severity]}>{ticket.severity}</Badge>
                          )}
                        </div>
                        <h3 className="font-semibold text-lg text-slate-900 mb-1">{ticket.subject}</h3>
                        <p className="text-sm text-slate-600 mb-2 line-clamp-2">{ticket.description}</p>
                        <div className="flex items-center gap-4 text-xs text-slate-500">
                          <span>From: {ticket.submitter_name}</span>
                          <div className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {ticket.created_date 
                              ? format(new Date(ticket.created_date), 'MMM d, yyyy h:mm a')
                              : 'Date not recorded'}
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Ticket Detail Dialog */}
        <Dialog open={!!selectedTicket} onOpenChange={() => setSelectedTicket(null)}>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            {selectedTicket && (
              <>
                <DialogHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        {React.createElement(typeIcons[selectedTicket.type], { className: "w-5 h-5 text-blue-600" })}
                        <Badge variant="outline">{typeLabels[selectedTicket.type]}</Badge>
                        <Select
                          value={selectedTicket.status}
                          onValueChange={(value) => handleUpdateTicket({ status: value })}
                        >
                          <SelectTrigger className="w-40 h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="open">Open</SelectItem>
                            <SelectItem value="in_progress">In Progress</SelectItem>
                            <SelectItem value="resolved">Resolved</SelectItem>
                            <SelectItem value="closed">Closed</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={selectedTicket.severity || "moderate"}
                          onValueChange={(value) => handleUpdateTicket({ severity: value })}
                        >
                          <SelectTrigger className="w-32 h-7 text-xs">
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
                      <DialogTitle className="text-2xl">{selectedTicket.subject}</DialogTitle>
                      <p className="text-sm text-slate-500 mt-2">
                        From: {selectedTicket.submitter_name} ({selectedTicket.submitter_email})
                      </p>
                      {selectedTicket.created_date && (
                        <p className="text-sm text-slate-500">
                          Submitted {format(new Date(selectedTicket.created_date), 'MMM d, yyyy h:mm a')}
                        </p>
                      )}
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

                  {/* Resolution Notes Field */}
                  {(selectedTicket.status === 'resolved' || selectedTicket.status === 'closed') && (
                    <div className="space-y-2">
                      <Label>Resolution Notes</Label>
                      <Textarea
                        placeholder="Add resolution notes..."
                        rows={3}
                        value={updateData.resolution_notes ?? selectedTicket.resolution_notes ?? ""}
                        onChange={(e) => setUpdateData({ ...updateData, resolution_notes: e.target.value })}
                        onBlur={() => {
                          if (updateData.resolution_notes !== undefined) {
                            handleUpdateTicket({ resolution_notes: updateData.resolution_notes });
                            setUpdateData({});
                          }
                        }}
                      />
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
                            {response.created_date && (
                              <span className="text-xs text-slate-500">
                                {format(new Date(response.created_date), 'MMM d, h:mm a')}
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-slate-700 whitespace-pre-wrap">{response.message}</p>
                          {response.attachments && response.attachments.length > 0 && (
                            <div className="mt-3 grid grid-cols-2 gap-2">
                              {response.attachments.map((url, idx) => (
                                <a
                                  key={idx}
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block"
                                >
                                  <img
                                    src={url}
                                    alt={`Attachment ${idx + 1}`}
                                    className="w-full h-32 object-cover rounded border border-slate-200 hover:opacity-90 transition-opacity"
                                  />
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Reply Section */}
                  <div className="space-y-3">
                    <Label>Add Response</Label>
                    <Textarea
                      placeholder="Type your response to the user..."
                      rows={4}
                      value={replyMessage}
                      onChange={(e) => setReplyMessage(e.target.value)}
                    />
                    
                    {/* Image Upload */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label htmlFor="response-images" className="cursor-pointer">
                          <div className="flex items-center gap-2 px-4 py-2 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors">
                            <Upload className="w-4 h-4" />
                            <span className="text-sm">
                              {uploadingImages ? 'Uploading...' : 'Attach Images'}
                            </span>
                          </div>
                        </Label>
                        <input
                          id="response-images"
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(e) => handleImageUpload(e.target.files)}
                          className="hidden"
                          disabled={uploadingImages}
                        />
                      </div>
                      
                      {responseAttachments.length > 0 && (
                        <div className="grid grid-cols-3 gap-2">
                          {responseAttachments.map((url, idx) => (
                            <div key={idx} className="relative group">
                              <img
                                src={url}
                                alt={`Upload ${idx + 1}`}
                                className="w-full h-24 object-cover rounded border border-slate-200"
                              />
                              <button
                                onClick={() => handleRemoveAttachment(url)}
                                className="absolute top-1 right-1 bg-red-600 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end">
                      <Button
                        onClick={handleAddResponse}
                        disabled={addResponseMutation.isPending || !replyMessage.trim() || uploadingImages}
                        className="bg-blue-600 hover:bg-blue-700"
                      >
                        Send Response
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}