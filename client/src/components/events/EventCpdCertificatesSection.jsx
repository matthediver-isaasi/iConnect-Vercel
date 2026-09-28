import { useEffect, useState } from "react";
import { FileBadge, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { ticketStableReference } from "@/lib/eventCpdBadgeRules";
import { formatCertificateValue } from "@/lib/cpdCertificateContract";
import { eventDateOnly, resolveEventCpdCertificatePolicy } from "../../../../shared/eventCpdCertificatePolicy.js";
import {
  emptyEventCpdCertificateConfig,
  normalizeEventCpdCertificateConfig,
  validateEventCpdCertificateConfig,
} from "@/lib/eventCpdCertificateRules";

const NO_TEMPLATE = "__none__";

function TemplateSelect({ value, templates, onChange, label }) {
  const selected = templates.find(template => template.id === value);
  const available = templates.filter(template => template.status === "active" && !template.unavailable);
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Select value={value || NO_TEMPLATE} onValueChange={next => onChange(next === NO_TEMPLATE ? null : next)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_TEMPLATE}>No certificate template</SelectItem>
          {available.map(template => <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>)}
          {value && !available.some(template => template.id === value) && (
            <SelectItem value={value} disabled>{selected?.name || value} (unavailable)</SelectItem>
          )}
        </SelectContent>
      </Select>
      {value && !available.some(template => template.id === value) && (
        <p role="alert" className="text-xs text-amber-700">
          This template is {selected?.unavailable ? "unavailable" : selected ? `not active (${selected.status})` : "unavailable or deleted"}. Select an available active template before using it.
        </p>
      )}
    </div>
  );
}

function EmailTemplateSelect({ value, templates, onChange, canManageEmailTemplates }) {
  const selected = templates.find(template => template.id === value);
  const available = templates.filter(template => template.is_active && !template.unavailable);
  const isUnavailable = !!value && !available.some(template => template.id === value);
  return (
    <div className="space-y-2 border-t pt-4" data-testid="event-cpd-email-template">
      <div>
        <Label htmlFor="cpd-email-template">Certificate email template (event-wide)</Label>
        <p className="text-xs text-muted-foreground">The message accompanying a manually emailed CPD certificate. This does not change the PDF template or ticket-specific certificate settings.</p>
      </div>
      <Select value={value || NO_TEMPLATE} onValueChange={next => onChange(next === NO_TEMPLATE ? null : next)}>
        <SelectTrigger id="cpd-email-template" data-testid="select-cpd-email-template"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_TEMPLATE}>Default certificate email (existing message)</SelectItem>
          {available.map(template => <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>)}
          {isUnavailable && <SelectItem value={value} disabled>{selected?.name || value} (unavailable)</SelectItem>}
        </SelectContent>
      </Select>
      {isUnavailable && <p role="alert" className="text-xs text-amber-700">
        The selected certificate email template is unavailable or inactive. Certificate PDF preview remains available, but emailing is blocked until you select an active template or the default email.
      </p>}
      {!available.length && !isUnavailable && <p className="text-sm text-muted-foreground">
        No active event email templates yet. The default certificate email will be used.
      </p>}
      {canManageEmailTemplates
        ? <Link className="text-sm text-primary underline" to={createPageUrl("EmailTemplateManagement")}>Create or edit event email templates</Link>
        : <p className="text-xs text-muted-foreground">Ask someone with email-template management access to set up a custom message.</p>}
    </div>
  );
}

function DateFields({ rule, onChange, label }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label>{label} start date</Label>
        <Input type="date" value={rule.start_date?.slice(0, 10) || ""} onChange={e => onChange({ ...rule, start_date: e.target.value || null })} />
      </div>
      <div className="space-y-1">
        <Label>{label} end date</Label>
        <Input type="date" value={rule.end_date?.slice(0, 10) || ""} onChange={e => onChange({ ...rule, end_date: e.target.value || null })} />
      </div>
    </div>
  );
}

function policySummary(policy, templateId, dates, templates) {
  const template = templates.find(item => item.id === (policy.template_id || templateId));
  const start = policy.reason === "invalid_policy" ? dates.start_date : policy.start_date;
  const end = policy.reason === "invalid_policy" ? dates.end_date : policy.end_date;
  const formatDate = date => formatCertificateValue(date, { field_type: "date", date_format: "date:long" });
  return `${template?.name || (templateId ? "Unavailable template" : "No template")} · ${
    start ? `${formatDate(start)}${end ? ` – ${formatDate(end)}` : ""}` : "Dates not set"
  }`;
}

export default function EventCpdCertificatesSection({
  eventId = null, eventType, tickets = [], eventDates = {}, value, onChange, canManageEmailTemplates = false,
}) {
  const [templates, setTemplates] = useState([]);
  const [emailTemplates, setEmailTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const config = value || emptyEventCpdCertificateConfig();
  const eventRule = config.eventRule || emptyEventCpdCertificateConfig().eventRule;

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ event_type: eventType });
    if (eventId) query.set("event_id", eventId);
    setLoading(true);
    fetch(`/api/admin/event-cpd-certificate-rules?${query}`, { credentials: "include" })
      .then(async response => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Failed to load certificate settings");
        if (cancelled) return;
        setTemplates(data.templates || []);
        setEmailTemplates(data.emailTemplates || []);
        if (eventId) onChange(normalizeEventCpdCertificateConfig(data.config));
        setError("");
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [eventId, eventType]); // Do not overwrite in-progress edits when tickets/dates change.

  const updateEvent = next => onChange({ ...config, eventRule: next });
  const updateTicket = (reference, patch) => onChange({
    ...config,
    ticketRules: {
      ...config.ticketRules,
      [reference]: { template_mode: "inherit", template_id: null, date_mode: "inherit", start_date: null, end_date: null,
        ...config.ticketRules?.[reference], ...patch },
    },
  });
  const errors = value ? validateEventCpdCertificateConfig(value, tickets) : [];
  const policyTemplates = templates.map(template => template.unavailable ? { ...template, status: "unavailable" } : template);
  const eventPolicy = resolveEventCpdCertificatePolicy({ config, event: eventDates, templates: policyTemplates });
  const inheritedDates = eventRule.date_mode === "custom"
    ? { start_date: eventRule.start_date, end_date: eventRule.end_date }
    : { start_date: eventDateOnly(eventDates.start_date, eventDates.timezone), end_date: eventDateOnly(eventDates.end_date, eventDates.timezone) };

  return (
    <Card className="border-slate-200 shadow-sm" data-testid="section-event-cpd-certificates">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileBadge className="h-5 w-5 text-indigo-600" />Certificates</CardTitle>
        <CardDescription>Choose a certificate template and date range for this event and, optionally, each ticket. These settings do not issue certificates or change CPD awards.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? <p className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Loading certificate templates…</p>
          : error ? <p role="alert" className="text-sm text-destructive">{error}. Settings cannot be saved until they load.</p>
            : <>
              <div className="space-y-3">
                <h3 className="font-medium">Event-wide certificate</h3>
                <TemplateSelect label="Template" value={eventRule.template_id} templates={templates}
                  onChange={template_id => updateEvent({ ...eventRule, template_id })} />
                <div className="space-y-1">
                  <Label>Certificate dates</Label>
                  <Select value={eventRule.date_mode} onValueChange={date_mode => updateEvent({ ...eventRule, date_mode, start_date: null, end_date: null })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="event">Use event dates</SelectItem>
                      <SelectItem value="custom">Custom dates</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {eventRule.date_mode === "custom" && <DateFields label="Certificate" rule={eventRule} onChange={updateEvent} />}
                <p className="text-xs text-muted-foreground">Effective: {policySummary(eventPolicy, eventRule.template_id, inheritedDates, templates)}</p>
                {eventPolicy.template_id && !eventPolicy.available && <p role="alert" className="text-xs text-amber-700">Certificate unavailable: {eventPolicy.reason?.replaceAll("_", " ")}.</p>}
              </div>
              <EmailTemplateSelect value={eventRule.email_template_id} templates={emailTemplates}
                canManageEmailTemplates={canManageEmailTemplates}
                onChange={email_template_id => updateEvent({ ...eventRule, email_template_id })} />
              <div className="space-y-3 border-t pt-4">
                <div><h3 className="font-medium">Ticket-specific overrides</h3>
                  <p className="text-xs text-muted-foreground">Each ticket can inherit, replace, or explicitly suppress the event template. Dates can be overridden independently.</p></div>
                {!tickets.length && <p className="text-sm text-muted-foreground">Add a ticket to configure an override.</p>}
                {tickets.map((ticket, index) => {
                  const ref = ticketStableReference(ticket);
                  const rule = config.ticketRules?.[ref] || { template_mode: "inherit", date_mode: "inherit" };
                  const policy = resolveEventCpdCertificatePolicy({ config, event: eventDates, ticketReference: ref, templates: policyTemplates });
                  const templateId = rule.template_mode === "none" ? null : rule.template_mode === "override" ? rule.template_id : eventRule.template_id;
                  const dates = rule.date_mode === "custom" ? rule : inheritedDates;
                  return <div key={ref} className="space-y-3 rounded-md border p-3" data-testid={`certificate-ticket-${ref}`}>
                    <h4 className="text-sm font-medium">{ticket.name || `Ticket ${index + 1}`}</h4>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1"><Label>Template</Label>
                        <Select value={rule.template_mode || "inherit"} onValueChange={template_mode => updateTicket(ref, { template_mode, template_id: null })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">Use event-wide template</SelectItem>
                            <SelectItem value="override">Choose another template</SelectItem>
                            <SelectItem value="none">No certificate</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1"><Label>Certificate dates</Label>
                        <Select value={rule.date_mode || "inherit"} onValueChange={date_mode => updateTicket(ref, { date_mode, start_date: null, end_date: null })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="inherit">Use event-wide dates</SelectItem>
                            <SelectItem value="custom">Custom dates</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {rule.template_mode === "override" && <TemplateSelect label="Override template" value={rule.template_id} templates={templates}
                      onChange={template_id => updateTicket(ref, { template_id })} />}
                    {rule.date_mode === "custom" && <DateFields label="Ticket certificate" rule={rule} onChange={next => updateTicket(ref, next)} />}
                    <p className="text-xs text-muted-foreground">Effective: {policySummary(policy, templateId, dates, templates)}</p>
                    {policy.template_id && !policy.available && (
                      <p role="alert" className="text-xs text-amber-700">Certificate unavailable: {policy.reason?.replaceAll("_", " ")}.</p>
                    )}
                  </div>;
                })}
              </div>
              {errors.length > 0 && <p role="alert" className="text-sm text-destructive">{errors[0]}</p>}
            </>}
      </CardContent>
    </Card>
  );
}