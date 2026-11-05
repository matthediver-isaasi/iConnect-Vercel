import React, { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import FieldConditionEditor from "@/components/audience/FieldConditionEditor";
import { popupConfig } from "@/lib/cmsPopups";
import { tenantDateTime, tenantDateTimeToUtc } from "@/lib/popupSchedule";
import { createPageUrl } from "@/utils";
import { validatePopupConfig, validatePopupGroups } from "@shared/cmsPopupContract.js";

export function PopupSelect({ label, value, onChange, options, disabled }) {
  return <label className="block space-y-1.5 text-sm font-medium">{label}<select disabled={disabled} className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm font-normal" value={value} onChange={(event) => onChange(event.target.value)}>
    {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
  </select></label>;
}
function Toggle({ label, checked, onChange, description }) {
  return <div className="flex items-center justify-between gap-5 rounded-md border p-3"><div><p className="text-sm font-medium">{label}</p>{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}</div><Switch aria-label={label} checked={checked} onCheckedChange={onChange} /></div>;
}
export default forwardRef(function PopupSettings({ popup, discovery, saving, onSave, canDesign, onDirtyChange }, ref) {
  const form = useRef(null);
  const navigate = useNavigate();
  const [draft, setDraft] = useState(() => ({ ...popup, config: popupConfig(popup) }));
  const timezone = discovery?.timezone || "UTC";
  const [starts, setStarts] = useState(() => tenantDateTime(popup.starts_at, timezone));
  const [ends, setEnds] = useState(() => tenantDateTime(popup.ends_at, timezone));
  const [error, setError] = useState("");
  const patch = (value) => { setDraft((previous) => ({ ...previous, ...value })); onDirtyChange?.(true); };
  const config = draft.config;
  const change = (value) => patch({ config: { ...config, ...value } });
  const modal = (value) => change({ modal: { ...config.modal, ...value } });
  const pages = (discovery?.pages || []).filter((page) => (page.microsite_id || null) === (popup.microsite_id || null));
  const numeric = (label, value, update, min, max) => <label className="block space-y-1.5 text-sm font-medium">{label}<Input type="number" value={value} min={min} max={max} required onChange={(e) => update(e.target.value === "" ? "" : Number(e.target.value))} /></label>;
  const submit = async (event) => {
    event?.preventDefault();
    if (saving || !canDesign || !form.current?.reportValidity()) return false;
    try {
      if (!draft.name.trim()) throw new Error("A popup name is required.");
      const starts_at = tenantDateTimeToUtc(starts, timezone);
      const ends_at = tenantDateTimeToUtc(ends, timezone);
      if (starts_at && ends_at && starts_at >= ends_at) throw new Error("End time must be after the start.");
      if (!config.all_pages && !config.page_ids.length && draft.status === "active") throw new Error("Assign at least one page before activation.");
      if (config.visibility === "guests" && config.groups.length) throw new Error("Guests cannot satisfy member or organisation targeting. Remove the targeting rules first.");
      validatePopupConfig(config);
      validatePopupGroups(config.groups, discovery?.fields || {});
      for (const group of config.groups) {
        if (!group.conditions?.length) throw new Error("Remove empty condition groups.");
        for (const condition of group.conditions) {
          const fields = [...(discovery?.fields?.[condition.entity_scope]?.core || []), ...(discovery?.fields?.[condition.entity_scope]?.custom || [])];
          if (!fields.some((field) => field.key === condition.field_key) || !condition.operator) throw new Error("Complete or remove unavailable targeting rules.");
          if (!["is_empty", "is_not_empty", "is_true", "is_false"].includes(condition.operator) && (condition.value === "" || condition.value == null || (Array.isArray(condition.value) && !condition.value.length))) throw new Error("Enter a value for every targeting rule.");
        }
      }
      setError("");
      await onSave({ id: popup.id, revision: popup.revision, name: draft.name.trim(), config, starts_at, ends_at });
      onDirtyChange?.(false);
      return true;
    } catch (failure) { setError(failure.message); return false; }
  };
  useImperativeHandle(ref, () => ({ save: () => submit() }));
  return <form ref={form} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
    <Tabs defaultValue="design" className="min-h-0 flex-1 overflow-auto">
      <TabsList className="mb-5 flex h-auto flex-wrap justify-start">{["Design", "Pages", "Audience", "Triggers", "Behaviour", "Settings"].map((tab) => <TabsTrigger key={tab} value={tab.toLowerCase()}>{tab}</TabsTrigger>)}</TabsList>
      <TabsContent value="design" className="space-y-5">
        <div className="rounded-lg border bg-muted/30 p-5"><h3 className="font-semibold">A Canvas document, inside a modal</h3><p className="mt-2 text-sm text-muted-foreground">Use the same responsive Canvas tools as your pages. Safe content blocks only; authentication, payment, booking, embeds and arbitrary HTML are not available.</p>
          <Button className="mt-4" disabled={!canDesign} type="button" onClick={() => navigate(`${createPageUrl("CanvasPopupEditor")}?popupId=${popup.id}`)}>Open Canvas editor</Button>
          {!canDesign && <p className="mt-2 text-xs text-muted-foreground">Requires Popup Editor permission.</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {numeric("Modal width (px)", config.modal.width, (width) => modal({ width }), 240, 1600)}
          {numeric("Maximum height (viewport %)", config.modal.max_height, (max_height) => modal({ max_height }), 20, 95)}
          {numeric("Content padding (px)", config.modal.padding, (padding) => modal({ padding }), 0, 96)}
          {numeric("Corner radius (px)", config.modal.radius, (radius) => modal({ radius }), 0, 96)}
          {numeric("Border width (px)", config.modal.border_width, (border_width) => modal({ border_width }), 0, 12)}
          <PopupSelect label="Shadow" value={config.modal.shadow} onChange={(shadow) => modal({ shadow })} options={[["none", "None"], ["sm", "Small"], ["md", "Medium"], ["lg", "Large"], ["xl", "Extra large"]]} />
          {[["background", "Background"], ["overlay", "Overlay (hex with optional alpha)"], ["border_color", "Border colour"]].map(([key, label]) => <label key={key} className="space-y-1.5 text-sm font-medium">{label}<Input value={config.modal[key]} pattern="#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?" onChange={(e) => modal({ [key]: e.target.value })} /></label>)}
          <PopupSelect label="Close position" value={config.modal.close_position} onChange={(close_position) => modal({ close_position })} options={[["right", "Right"], ["left", "Left"]]} />
        </div>
      </TabsContent>
      <TabsContent value="pages" className="space-y-4">
        <p className="text-sm text-muted-foreground">Scope: <strong>{(discovery?.microsites || []).find((site) => site.id === popup.microsite_id)?.name || "Main site"}</strong>. Typography and page assignments stay within this site. To use another scope, create a new popup.</p>
        <Toggle label="All eligible CMS pages in this site" checked={config.all_pages} onChange={(all_pages) => change({ all_pages })} />
        {!config.all_pages && <div className="max-h-80 space-y-2 overflow-auto rounded-md border p-3">
          {pages.length ? pages.map((page) => <label key={page.id} className="flex items-center gap-3 rounded p-2 text-sm hover:bg-muted"><input type="checkbox" checked={config.page_ids.includes(page.id)} onChange={(e) => change({ page_ids: e.target.checked ? [...config.page_ids, page.id] : config.page_ids.filter((id) => id !== page.id) })} /><span>{page.title || page.name || page.slug}<span className="ml-2 text-xs text-muted-foreground">{page.status}</span></span></label>) : <p className="text-sm text-muted-foreground">No eligible pages in this site yet.</p>}
          {config.page_ids.filter((id) => !pages.some((page) => page.id === id)).map((id) => <div key={id} className="flex items-center justify-between text-sm text-destructive">Unavailable page: {id}<Button type="button" size="sm" variant="ghost" onClick={() => change({ page_ids: config.page_ids.filter((value) => value !== id) })}>Remove</Button></div>)}
        </div>}
      </TabsContent>
      <TabsContent value="audience" className="space-y-5">
        <PopupSelect label="Who can see this popup?" value={config.visibility} onChange={(visibility) => change({ visibility })} options={[["public", "Public — members and guests"], ["members", "Members only"], ["guests", "Guests only"]]} />
        <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">Groups are joined with OR; conditions inside a group use AND. Every organisation condition in one group must match the <strong>same affiliated organisation</strong>. Anonymous visitors cannot match data-targeting rules.</div>
        {config.visibility === "guests" && config.groups.length > 0 && <p role="alert" className="text-sm text-destructive">Guests cannot match these rules. Remove the conditions or change visibility.</p>}
        <FieldConditionEditor groups={config.groups} onChange={(groups) => change({ groups })} metadata={discovery?.fields} disabled={!discovery?.fields} />
        <p className="text-xs text-muted-foreground">Membership attributes and explicitly selected organisations are available only where the server provides authoritative field options. Missing fields never silently broaden an audience.</p>
      </TabsContent>
      <TabsContent value="triggers" className="space-y-5">
        <PopupSelect label="Show when" value={config.trigger.type} onChange={(type) => change({ trigger: { type, value: 0 } })} options={[["immediate", "Page is ready"], ["delay", "After a delay"], ["scroll_percent", "Scroll percentage"], ["scroll_pixels", "Scroll distance"]]} />
        {config.trigger.type !== "immediate" && numeric(config.trigger.type === "delay" ? "Delay (seconds)" : config.trigger.type === "scroll_percent" ? "Page scrolled (%)" : "Scroll distance (px)", config.trigger.value, (value) => change({ trigger: { ...config.trigger, value } }), 0, config.trigger.type === "scroll_percent" ? 100 : 86400)}
        {numeric("Priority", config.priority, (priority) => change({ priority }), -10000, 10000)}
        <p className="text-sm text-muted-foreground">Higher numbers win among trigger-ready popups. Delayed popups do not block ready popups. Only one popup can open per history-entry page view.</p>
      </TabsContent>
      <TabsContent value="behaviour" className="space-y-4">
        <PopupSelect label="Frequency" value={config.frequency.type} onChange={(type) => change({ frequency: { ...config.frequency, type } })} options={[["page_view", "Each page view"], ["session", "Once per browser session"], ["day", "Once per tenant-calendar day"], ["n_days", "Once every N days"], ["until_dismissed", "Until permanently dismissed"]]} />
        {config.frequency.type === "n_days" && numeric("Days (elapsed 24-hour periods)", config.frequency.days, (days) => change({ frequency: { ...config.frequency, days } }), 1, 3650)}
        <Toggle label="Offer “Hide for this session”" checked={config.allow_session} onChange={(allow_session) => change({ allow_session })} description="Browser session storage is per tab; unavailable storage uses memory." />
        <Toggle label="Offer “Don't show again”" checked={config.allow_permanent} onChange={(allow_permanent) => change({ allow_permanent })} description="Members: across devices. Guests: this browser, with storage consent. Permanent dismissal always wins." />
        <p className="text-sm text-muted-foreground">Close is always available. Popups defer during cookie decisions, other dialogs, authentication, booking, payment and active form interaction. Access and archive changes are rechecked every 30 seconds while open, and on focus return.</p>
      </TabsContent>
      <TabsContent value="settings" className="space-y-5">
        <div className="space-y-1.5"><Label htmlFor="popup-name">Internal name</Label><Input id="popup-name" value={draft.name} required maxLength={120} onChange={(e) => patch({ name: e.target.value })} /></div>
        <p className="text-sm text-muted-foreground">Schedule in <strong>{timezone}</strong>. Blank dates mean no boundary. Schedules do not change the saved lifecycle status. Ambiguous or nonexistent daylight-saving times are rejected.</p>
        <label className="block space-y-1.5 text-sm font-medium">Starts at<Input type="datetime-local" value={starts} onChange={(e) => { setStarts(e.target.value); onDirtyChange?.(true); }} /></label>
        <label className="block space-y-1.5 text-sm font-medium">Ends at<Input type="datetime-local" value={ends} onChange={(e) => { setEnds(e.target.value); onDirtyChange?.(true); }} /></label>
        <div className="rounded border p-3 text-xs text-muted-foreground">Revision {popup.revision} · Dismissal generation {popup.dismissal_generation}. Ordinary edits, pause and archive preserve opt-outs. Reset dismissals is a separate confirmed action.</div>
      </TabsContent>
    </Tabs>
    <div className="mt-5 flex shrink-0 items-center justify-between gap-4 border-t pt-4">
      <div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<p className="text-xs text-muted-foreground">{config.visibility} · {config.all_pages ? "All scoped pages" : `${config.page_ids.length} selected pages`} · {config.trigger.type.replaceAll("_", " ")} · {config.frequency.type.replaceAll("_", " ")}</p></div>
      <Button type="submit" disabled={saving || !canDesign}>{saving ? "Saving…" : canDesign ? "Save settings" : "Editor permission required"}</Button>
    </div>
  </form>;
});
