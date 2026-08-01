import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Check, Bell, Clock, Download, Trash2, Loader2, Mail, Code, FileText, AlertCircle } from "lucide-react";
import { TimezoneAwareDateTimeInput } from "@/components/events/TimezoneAwareDateTimeInput";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";

// Shared confirmation/reminder email settings editor for events.
// Extracted from EditEvent.jsx / CreateComplexEvent.jsx (Task #3263) so the
// same UI can run against pure local state during event creation (no event ID
// required) as well as in edit mode.
//
// `mode` controls timing wording: 'event' (single events) or 'session'
// (complex events, where reminders are relative to each session start).

export const getTimingOptions = (mode = "event") => {
  const suffix = mode === "session" ? "session" : "";
  const lbl = (s) => (suffix ? `${s} ${suffix}` : s);
  return [
    { value: "7_days_before", label: lbl("7 days before") },
    { value: "3_days_before", label: lbl("3 days before") },
    { value: "1_day_before", label: lbl("1 day before") },
    { value: "12_hours_before", label: lbl("12 hours before") },
    { value: "6_hours_before", label: lbl("6 hours before") },
    { value: "1_hour_before", label: lbl("1 hour before") },
    { value: "30_minutes_before", label: lbl("30 minutes before") },
    { value: "custom", label: "Custom timing" },
  ];
};

export const createEmptyEmail = (emailType = "reminder") => ({
  id: `email-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
  email_type: emailType,
  timing_type: emailType === "booking_confirmation" ? null : "1_day_before",
  custom_hours_before: null,
  custom_unit: "hours",
  custom_send_at: null,
  subject: emailType === "booking_confirmation"
    ? "Your booking confirmation for {{event_name}}"
    : "Reminder: {{event_name}} is coming up!",
  body: emailType === "booking_confirmation"
    ? "Dear {{attendee_first_name}},\n\nThank you for booking {{event_name}}.\n\nEvent Date: {{event_date}}\nLocation: {{event_location}}\n{{#zoom_link}}Join Link: {{zoom_link}}{{/zoom_link}}\n\nWe look forward to seeing you!"
    : "Dear {{attendee_first_name}},\n\nThis is a reminder that {{event_name}} is coming up soon.\n\nEvent Date: {{event_date}}\nLocation: {{event_location}}\n{{#zoom_link}}Join Link: {{zoom_link}}{{/zoom_link}}\n\nSee you there!",
  cc: "",
  is_enabled: true,
  isNew: true,
});

// Build a human-friendly label for an email row, used in error messaging.
export const getEmailRowLabel = (email, mode = "event") => {
  const before = mode === "session" ? "before session" : "before event";
  if (email.email_type === "booking_confirmation") return "Booking confirmation email";
  if (email.email_type === "reminder") {
    if (email.timing_type === "custom") {
      const unit = email.custom_unit || "hours";
      if (unit === "specific_datetime") return "Reminder — Absolute date/time";
      const n = email.custom_hours_before;
      return `Reminder — Custom (${n ? `${n} ${unit}` : unit} ${before})`;
    }
    const opt = getTimingOptions(mode).find((o) => o.value === email.timing_type);
    return `Reminder — ${opt ? opt.label : (email.timing_type || "unscheduled")}`;
  }
  return email.email_type || "Email";
};

// Validate the comma-separated CC fields; returns a list of invalid addresses.
export const findInvalidCcAddresses = (emails) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const invalid = [];
  for (const e of emails) {
    if (!e.cc) continue;
    const parts = String(e.cc).split(",").map((s) => s.trim()).filter(Boolean);
    invalid.push(...parts.filter((p) => !emailRegex.test(p)));
  }
  return invalid;
};

export const formatSchedulingFailures = (scheduling) => {
  const parts = [];
  const failures = scheduling.schedulingFailures || [];
  if (failures.length > 0) {
    const totalBookings = failures.reduce((s, f) => s + (f.failed_booking_count || 0), 0);
    const reasons = Array.from(new Set(failures.map((f) => f.reason).filter(Boolean))).slice(0, 2).join("; ");
    parts.push(`${failures.length} reminder(s) could not be queued for ${totalBookings} booking(s)${reasons ? ` — ${reasons}` : ""}`);
  }
  if (scheduling.error) parts.push(`scheduler error: ${scheduling.error}`);
  return parts.join(" · ") || "reminders could not be queued";
};

export const formatSkippedSummary = (skipped) => {
  const counts = {};
  for (const s of skipped) {
    counts[s.reason] = (counts[s.reason] || 0) + 1;
  }
  return Object.entries(counts).map(([r, n]) => `${n} skipped: ${r}`).join(", ");
};

// PUT the email configuration for an event. Returns { response, result }.
// Throws only on network-level failure; callers inspect response.ok.
export const putEventEmails = async (eventId, emails, isComplexEvent = false) => {
  const response = await fetch(`/api/event-emails/${eventId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(
      isComplexEvent ? { emails, is_complex_event: true } : { emails }
    ),
  });
  const result = await response.json();
  return { response, result };
};

// Map a failed-save response's `details` array back to email rows.
// Returns { errMap (email.id -> message), failedIndexes (Set of request idx) }.
export const mapEmailSaveFailureDetails = (details, requestEmails) => {
  const errMap = {};
  const failedIndexes = new Set();
  const unindexedDetails = [];
  for (const detail of details) {
    if (typeof detail.request_index === "number" && requestEmails[detail.request_index]) {
      failedIndexes.add(detail.request_index);
      errMap[requestEmails[detail.request_index].id] = detail.error || "Unknown error";
    } else {
      unindexedDetails.push(detail);
    }
  }
  // Fallback for older API responses without request_index — match by
  // email_type in request order.
  if (unindexedDetails.length > 0) {
    const typeErrCursor = {};
    for (const detail of unindexedDetails) {
      const seen = typeErrCursor[detail.email_type] || 0;
      let count = 0;
      let foundIdx = -1;
      for (let i = 0; i < requestEmails.length; i++) {
        if (failedIndexes.has(i)) continue;
        if (requestEmails[i].email_type === detail.email_type) {
          if (count === seen) { foundIdx = i; break; }
          count++;
        }
      }
      typeErrCursor[detail.email_type] = seen + 1;
      if (foundIdx >= 0) {
        failedIndexes.add(foundIdx);
        errMap[requestEmails[foundIdx].id] = detail.error || "Unknown error";
      }
    }
  }
  return { errMap, failedIndexes };
};

const EMAIL_QUILL_MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ color: [] }, { background: [] }],
    [{ list: "ordered" }, { list: "bullet" }],
    [{ align: [] }],
    ["link"],
    ["clean"],
  ],
};

export default function EventEmailSettingsEditor({
  emails,
  setEmails,
  emailTemplates = [],
  saveErrors = {},
  onRowEdited,
  eventTimezone = "Europe/London",
  isTimezoneLoading = false,
  loading = false,
  mode = "event",
}) {
  const [codeViewMode, setCodeViewMode] = useState({});
  const timingOptions = getTimingOptions(mode);
  const unitSuffix = mode === "session" ? "session" : "event";

  const updateEmail = (emailId, field, value) => {
    setEmails((prev) => prev.map((e) => (e.id === emailId ? { ...e, [field]: value } : e)));
    onRowEdited?.(emailId);
  };

  const removeEmail = (emailId) => {
    setEmails((prev) => prev.filter((e) => e.id !== emailId));
  };

  const loadTemplateIntoEmail = (emailId, templateId) => {
    const template = emailTemplates.find((t) => t.id === templateId);
    if (!template) return;
    setEmails((prev) => prev.map((e) =>
      e.id === emailId
        ? {
            ...e,
            subject: template.subject || e.subject,
            body: template.body || e.body,
            loaded_template_id: templateId,
            loaded_template_name: template.name,
          }
        : e
    ));
    toast.success(`Loaded template: ${template.name}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        <span className="ml-2 text-slate-500">Loading email configurations...</span>
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="text-center py-8 text-slate-500">
        <Mail className="h-12 w-12 mx-auto mb-3 text-slate-300" />
        <p>No email configurations yet</p>
        <p className="text-sm mt-1">Add a confirmation or reminder email to get started</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {emails.map((email) => (
        <div
          key={email.id}
          className={`p-4 border rounded-lg ${email.email_type === "booking_confirmation" ? "border-green-200 bg-green-50" : "border-blue-200 bg-blue-50"}`}
        >
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              {email.email_type === "booking_confirmation" ? (
                <Badge variant="outline" className="bg-green-100 text-green-700 border-green-300">
                  <Check className="h-3 w-3 mr-1" />
                  Confirmation
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-blue-100 text-blue-700 border-blue-300">
                  <Bell className="h-3 w-3 mr-1" />
                  Reminder
                </Badge>
              )}
              <div className="flex items-center gap-2">
                <Switch
                  checked={email.is_enabled}
                  onCheckedChange={(checked) => updateEmail(email.id, "is_enabled", checked)}
                  data-testid={`switch-email-enabled-${email.id}`}
                />
                <span className="text-sm text-slate-600">
                  {email.is_enabled ? "Enabled" : "Disabled"}
                </span>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => removeEmail(email.id)}
              className="text-slate-400 hover:text-red-500"
              data-testid={`button-remove-email-${email.id}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          {saveErrors[email.id] && (
            <div
              className="mb-3 flex items-start gap-2 p-3 rounded-md border border-red-200 bg-red-50 text-red-800 text-sm"
              data-testid={`email-save-error-${email.id}`}
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="font-medium">
                  Failed to save: {getEmailRowLabel(email, mode)}
                </div>
                <div className="text-xs mt-0.5 break-words">
                  {saveErrors[email.id]}
                </div>
              </div>
            </div>
          )}

          {/* Timing Selection for Reminders */}
          {email.email_type === "reminder" && (
            <div className="mb-3">
              <Label className="text-sm font-medium flex items-center gap-1 mb-2">
                <Clock className="h-4 w-4" />
                Send Timing
              </Label>
              <Select
                value={email.timing_type || "1_day_before"}
                onValueChange={(value) => updateEmail(email.id, "timing_type", value)}
              >
                <SelectTrigger className="w-full bg-white" data-testid={`select-timing-${email.id}`}>
                  <SelectValue placeholder="Select when to send" />
                </SelectTrigger>
                <SelectContent>
                  {timingOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {email.timing_type === "custom" && (
                <div className="mt-2 space-y-2">
                  <Select
                    value={email.custom_unit || "hours"}
                    onValueChange={(value) => updateEmail(email.id, "custom_unit", value)}
                  >
                    <SelectTrigger className="w-full bg-white" data-testid={`select-custom-unit-${email.id}`}>
                      <SelectValue placeholder="Select unit" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="days">Days before {unitSuffix}</SelectItem>
                      <SelectItem value="hours">Hours before {unitSuffix}</SelectItem>
                      <SelectItem value="minutes">Minutes before {unitSuffix}</SelectItem>
                      <SelectItem value="specific_datetime">Specific date & time</SelectItem>
                    </SelectContent>
                  </Select>

                  {(email.custom_unit || "hours") !== "specific_datetime" ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min="1"
                        value={email.custom_hours_before || ""}
                        onChange={(e) => updateEmail(email.id, "custom_hours_before", parseInt(e.target.value) || null)}
                        placeholder={
                          (email.custom_unit || "hours") === "days" ? "Days" :
                          (email.custom_unit || "hours") === "minutes" ? "Minutes" : "Hours"
                        }
                        className="w-24 bg-white"
                        data-testid={`input-custom-value-${email.id}`}
                      />
                      <span className="text-sm text-slate-600">
                        {(email.custom_unit || "hours") === "days" ? `days before ${unitSuffix}` :
                         (email.custom_unit || "hours") === "minutes" ? `minutes before ${unitSuffix}` : `hours before ${unitSuffix}`}
                      </span>
                    </div>
                  ) : (
                    <div>
                      <TimezoneAwareDateTimeInput
                        tz={eventTimezone}
                        isReady={!isTimezoneLoading}
                        value={email.custom_send_at}
                        onChange={(iso) => updateEmail(email.id, "custom_send_at", iso || null)}
                        className="w-full bg-white"
                        data-testid={`input-custom-datetime-${email.id}`}
                      />
                      <p className="text-xs text-slate-500 mt-1">
                        Choose the exact date and time to send this reminder
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Load from Template */}
          {emailTemplates.length > 0 && (
            <div className="mb-3">
              <Label className="text-sm font-medium mb-2 block flex items-center gap-2">
                <Download className="h-4 w-4" />
                Load from Template
              </Label>
              <div className="flex gap-2">
                <Select
                  value={email.loaded_template_id || "none"}
                  onValueChange={(templateId) => {
                    if (templateId !== "none") {
                      loadTemplateIntoEmail(email.id, templateId);
                    }
                  }}
                >
                  <SelectTrigger className="bg-white" data-testid={`select-template-${email.id}`}>
                    <SelectValue placeholder="Select a template to load..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select a template to load...</SelectItem>
                    {emailTemplates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {email.loaded_template_name && (
                <p className="text-xs text-slate-500 mt-1">
                  Based on: {email.loaded_template_name} (edits won't affect the original template)
                </p>
              )}
            </div>
          )}

          {/* Subject Line */}
          <div className="mb-3">
            <Label className="text-sm font-medium mb-2 block">Subject</Label>
            <Input
              value={email.subject}
              onChange={(e) => updateEmail(email.id, "subject", e.target.value)}
              placeholder="Email subject line"
              className="bg-white"
              data-testid={`input-email-subject-${email.id}`}
            />
          </div>

          {/* CC */}
          <div className="mb-3">
            <Label className="text-sm font-medium mb-2 block">CC (optional)</Label>
            <Input
              value={email.cc || ""}
              onChange={(e) => updateEmail(email.id, "cc", e.target.value)}
              placeholder="team@example.com, manager@example.com"
              className="bg-white"
              data-testid={`input-email-cc-${email.id}`}
            />
            <p className="text-xs text-slate-500 mt-1">
              Comma-separate multiple addresses to CC on every send.
            </p>
          </div>

          {/* Email Body with Plain Text / Rich Text Toggle */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">Body</Label>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant={codeViewMode[email.id] === "richtext" ? "ghost" : "secondary"}
                  size="sm"
                  onClick={() => setCodeViewMode((prev) => ({ ...prev, [email.id]: undefined }))}
                  className="h-7 px-2"
                  data-testid={`button-plain-text-${email.id}`}
                >
                  <Code className="h-3 w-3 mr-1" />
                  Plain Text
                </Button>
                <Button
                  type="button"
                  variant={codeViewMode[email.id] === "richtext" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setCodeViewMode((prev) => ({ ...prev, [email.id]: "richtext" }))}
                  className="h-7 px-2"
                  data-testid={`button-rich-text-${email.id}`}
                >
                  <FileText className="h-3 w-3 mr-1" />
                  Rich Text
                </Button>
              </div>
            </div>

            {codeViewMode[email.id] === "richtext" ? (
              <div className="bg-white border rounded-md overflow-hidden">
                <ReactQuill
                  theme="snow"
                  value={email.body || ""}
                  onChange={(value) => updateEmail(email.id, "body", value)}
                  modules={EMAIL_QUILL_MODULES}
                  placeholder="Email body content"
                  className="[&_.ql-editor]:min-h-[150px]"
                  data-testid={`quill-email-body-${email.id}`}
                />
              </div>
            ) : (
              <Textarea
                value={email.body}
                onChange={(e) => updateEmail(email.id, "body", e.target.value)}
                placeholder="Email body content"
                className="bg-white min-h-[200px]"
                data-testid={`textarea-email-body-${email.id}`}
              />
            )}
            <p className="text-xs text-slate-500 mt-1">
              Available placeholders: {'{{event_name}}'}, {'{{event_date}}'}, {'{{event_location}}'}, {'{{attendee_first_name}}'}, {'{{zoom_link}}'}{mode === "session" ? <>, {'{{session_schedule}}'}</> : null}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
