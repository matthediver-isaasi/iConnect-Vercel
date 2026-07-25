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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Bug, Lightbulb, HelpCircle, Mail, CheckCircle, AlertCircle, Upload, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { showUploadErrorToast } from "@/lib/planQuotaError";
import { format } from "date-fns";
import TicketConversation from "@/components/support/TicketConversation";

export const typeIcons = {
  bug: Bug,
  feature_request: Lightbulb,
  how_to: HelpCircle,
  general: Mail,
};

export const typeLabels = {
  bug: "Bug Report",
  feature_request: "Feature Request",
  how_to: "How-To Question",
  general: "General Message",
};

export const statusColors = {
  open: "bg-blue-100 text-blue-800",
  in_progress: "bg-warning/10 text-warning",
  resolved: "bg-green-100 text-green-800",
  closed: "bg-slate-100 text-slate-800",
};

/**
 * Resolves the tenant's public support settings (severity levels, areas,
 * submission instructions and default severity) once, shared by every surface
 * that renders the support ticket dialogs.
 */
export function useSupportSettings() {
  const { data: supportSettings = [] } = useQuery({
    queryKey: ["public-support-settings"],
    queryFn: () => publicClient.listSystemSettings(),
    staleTime: 30000,
  });

  const supportLevels = useMemo(() => resolveSupportLevels(supportSettings), [supportSettings]);
  const supportAreas = useMemo(() => resolveSupportAreas(supportSettings), [supportSettings]);
  const supportInstructions = useMemo(() => resolveSupportInstructions(supportSettings), [supportSettings]);
  const defaultSeverity = useMemo(() => getDefaultSeverity(supportLevels), [supportLevels]);

  return { supportLevels, supportAreas, supportInstructions, defaultSeverity };
}

const EMPTY_TICKET = {
  type: "general",
  subject: "",
  description: "",
  severity: "moderate",
  area: "",
  attachments: [],
};

/**
 * Create Support Ticket dialog. Owns its form state; resets to a blank form
 * (with the tenant default severity) every time it is opened. Submits through
 * the same SupportTicket entity route as /support so admin notifications fire
 * unchanged.
 */
export function NewSupportTicketDialog({
  open,
  onOpenChange,
  memberInfo,
  supportLevels,
  supportAreas,
  supportInstructions,
  defaultSeverity,
}) {
  const queryClient = useQueryClient();
  const [newTicket, setNewTicket] = useState(EMPTY_TICKET);
  const [uploadingFile, setUploadingFile] = useState(false);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setNewTicket({ ...EMPTY_TICKET, severity: defaultSeverity });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // If the modal is opened before tenant support settings finish loading, sync the
  // pre-selected severity to the tenant default once it resolves (unless the user
  // already picked a value that exists in the configured levels).
  useEffect(() => {
    if (!open) return;
    const isValid = supportLevels.some((lvl) => lvl.value === newTicket.severity);
    if (!isValid && newTicket.severity !== defaultSeverity) {
      setNewTicket((prev) => ({ ...prev, severity: defaultSeverity }));
    }
  }, [open, supportLevels, defaultSeverity]); // eslint-disable-line react-hooks/exhaustive-deps

  const createTicketMutation = useMutation({
    mutationFn: (ticketData) => base44.entities.SupportTicket.create(ticketData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-tickets"] });
      toast.success("Support ticket submitted successfully");
      onOpenChange(false);
      setNewTicket({ ...EMPTY_TICKET, severity: defaultSeverity });
    },
    onError: () => toast.error("Failed to submit ticket"),
  });

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingFile(true);
    try {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      setNewTicket((prev) => ({ ...prev, attachments: [...prev.attachments, file_url] }));
      toast.success("File uploaded");
    } catch (error) {
      showUploadErrorToast(error, "Failed to upload file");
    } finally {
      setUploadingFile(false);
    }
  };

  const handleRemoveAttachment = (index) => {
    setNewTicket((prev) => ({
      ...prev,
      attachments: prev.attachments.filter((_, i) => i !== index),
    }));
  };

  const handleCreateTicket = () => {
    if (!newTicket.subject.trim() || !newTicket.description.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    createTicketMutation.mutate({
      ...newTicket,
      submitter_email: memberInfo.email,
      submitter_name: `${memberInfo.first_name} ${memberInfo.last_name}`,
      created_date: new Date().toISOString(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
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
  );
}

/**
 * View Support Ticket dialog: ticket details plus the shared chat-style
 * conversation (TicketConversation). Members can always reply — replying to a
 * resolved/closed ticket reopens it.
 */
export function ViewSupportTicketDialog({
  ticket,
  onClose,
  memberInfo,
  supportLevels,
  supportAreas,
  ticketQueryKeys,
  onTicketUpdated,
}) {
  const resolvedTicketQueryKeys = useMemo(
    () => ticketQueryKeys || [["support-tickets", memberInfo?.email]],
    [ticketQueryKeys, memberInfo?.email]
  );

  return (
    <Dialog open={!!ticket} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        {ticket && (
          <>
            <DialogHeader>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    {React.createElement(typeIcons[ticket.type], { className: "w-5 h-5 text-blue-600" })}
                    <Badge variant="outline">{typeLabels[ticket.type]}</Badge>
                    <Badge className={statusColors[ticket.status]}>
                      {ticket.status.replace('_', ' ')}
                    </Badge>
                    {ticket.severity && (
                      <Badge className={getSeverityBadgeClass(ticket.severity)}>
                        {getSeverityLabel(supportLevels, ticket.severity)}
                      </Badge>
                    )}
                    {ticket.area && (
                      <Badge className={AREA_BADGE_CLASS}>
                        {getAreaLabel(supportAreas, ticket.area)}
                      </Badge>
                    )}
                  </div>
                  <DialogTitle className="text-2xl">{ticket.subject}</DialogTitle>
                  <div className="mt-2 space-y-1">
                    <p className="text-sm text-slate-500">
                      Submitted {format(new Date(ticket.created_date), 'MMM d, yyyy h:mm a')}
                    </p>
                    <p className="text-sm text-slate-600">
                      <span className="font-medium">By:</span> {ticket.submitter_name || 'Unknown'} 
                      {ticket.submitter_email && (
                        <span className="text-slate-500"> ({ticket.submitter_email})</span>
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-6">
              {/* Resolution Notes */}
              {ticket.resolution_notes && (
                <div className="bg-green-50 rounded-lg p-4 border border-green-200">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="w-4 h-4 text-green-600" />
                    <span className="font-semibold text-green-900">Resolution</span>
                  </div>
                  <p className="text-sm text-green-700">{ticket.resolution_notes}</p>
                </div>
              )}

              {/* Conversation */}
              <TicketConversation
                ticket={ticket}
                memberInfo={memberInfo}
                ticketQueryKeys={resolvedTicketQueryKeys}
                onTicketUpdated={onTicketUpdated}
              />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
