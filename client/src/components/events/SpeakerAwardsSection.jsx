// Task #3285: "Speaker awards" section for event create/edit (simple and
// complex). Admins configure a default training-voucher amount + expiry and/or
// a library badge for all speakers, with per-speaker overrides/exclusions.
// Nothing is granted at save time — a scheduled job grants awards when the
// event starts, so late speaker changes are respected.
import React, { useState, useEffect, useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Award, Info, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";

const NO_BADGE = "__none__";

function emptyConfig() {
  return { enabled: false, default: { voucher_value: "", voucher_expiry: "", badge_id: null }, overrides: {} };
}

// Convert stored config (numbers/nulls) into editable form state (strings).
export function configToFormState(raw) {
  if (!raw || typeof raw !== "object") return emptyConfig();
  const def = raw.default || {};
  const overrides = {};
  Object.entries(raw.overrides || {}).forEach(([id, o]) => {
    if (!o || typeof o !== "object") return;
    overrides[id] = o.excluded === true
      ? { excluded: true }
      : {
          voucher_value: o.voucher_value != null ? String(o.voucher_value) : "",
          voucher_expiry: o.voucher_expiry ? String(o.voucher_expiry).slice(0, 10) : "",
          badge_id: o.badge_id || null,
        };
  });
  return {
    enabled: raw.enabled === true,
    default: {
      voucher_value: def.voucher_value != null ? String(def.voucher_value) : "",
      voucher_expiry: def.voucher_expiry ? String(def.voucher_expiry).slice(0, 10) : "",
      badge_id: def.badge_id || null,
    },
    overrides,
  };
}

// Convert form state into the persisted config (or null when disabled/empty).
export function formStateToConfig(state) {
  if (!state || state.enabled !== true) return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const overrides = {};
  Object.entries(state.overrides || {}).forEach(([id, o]) => {
    if (!o) return;
    if (o.excluded === true) {
      overrides[id] = { excluded: true };
      return;
    }
    const entry = {
      voucher_value: num(o.voucher_value),
      voucher_expiry: o.voucher_expiry || null,
      badge_id: o.badge_id || null,
    };
    if (entry.voucher_value || entry.voucher_expiry || entry.badge_id) overrides[id] = entry;
  });
  return {
    enabled: true,
    default: {
      voucher_value: num(state.default?.voucher_value),
      voucher_expiry: state.default?.voucher_expiry || null,
      badge_id: state.default?.badge_id || null,
    },
    overrides,
  };
}

function effectiveAward(state, speakerId) {
  const o = state.overrides?.[speakerId];
  if (o?.excluded) return { excluded: true };
  return {
    voucher_value: (o && o.voucher_value !== "" && o.voucher_value != null) ? o.voucher_value : state.default?.voucher_value,
    voucher_expiry: (o && o.voucher_expiry) ? o.voucher_expiry : state.default?.voucher_expiry,
    badge_id: (o && o.badge_id) ? o.badge_id : state.default?.badge_id,
  };
}

export default function SpeakerAwardsSection({ speakers, value, onChange, eventId, eventType }) {
  const state = value || emptyConfig();
  const [badges, setBadges] = useState([]);
  const [eligibility, setEligibility] = useState({});
  const [grants, setGrants] = useState(null);

  const speakerIdsKey = useMemo(
    () => (speakers || []).map(s => s.id).sort().join(","),
    [speakers]
  );

  useEffect(() => {
    if (!state.enabled) return;
    let cancelled = false;
    base44.entities.Badge.list()
      .then(list => { if (!cancelled) setBadges((list || []).filter(b => b.is_active !== false)); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.enabled]);

  useEffect(() => {
    if (!state.enabled || !speakerIdsKey) { setEligibility({}); return; }
    let cancelled = false;
    fetch("/api/admin/speaker-award-eligibility", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker_ids: speakerIdsKey.split(",") }),
    })
      .then(r => (r.ok ? r.json() : { eligibility: {} }))
      .then(d => { if (!cancelled) setEligibility(d.eligibility || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [state.enabled, speakerIdsKey]);

  // When editing a started event, show what was actually granted.
  useEffect(() => {
    if (!eventId || !eventType) return;
    let cancelled = false;
    fetch(`/api/admin/speaker-award-grants?event_id=${encodeURIComponent(eventId)}&event_type=${encodeURIComponent(eventType)}`, { credentials: "include" })
      .then(r => (r.ok ? r.json() : { grants: [] }))
      .then(d => { if (!cancelled && (d.grants || []).length > 0) setGrants(d.grants); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [eventId, eventType]);

  const update = (patch) => onChange({ ...state, ...patch });
  const updateDefault = (patch) => update({ default: { ...state.default, ...patch } });
  const updateOverride = (speakerId, patch) => {
    const current = state.overrides?.[speakerId];
    const base = current && !current.excluded ? current : { voucher_value: "", voucher_expiry: "", badge_id: null };
    update({ overrides: { ...state.overrides, [speakerId]: { ...base, ...patch } } });
  };
  const clearOverride = (speakerId) => {
    const next = { ...state.overrides };
    delete next[speakerId];
    update({ overrides: next });
  };

  const badgeName = (id) => badges.find(b => b.id === id)?.name || "Badge";

  const grantStatusLabel = {
    pending: "Pending — will retry shortly",
    granted: "Granted",
    skipped_excluded: "Excluded",
    skipped_no_member: "Skipped — no linked member",
    skipped_no_award: "No award configured",
  };

  return (
    <div className="space-y-3 border border-slate-200 rounded-lg p-4" data-testid="section-speaker-awards">
      <div className="flex items-center justify-between">
        <Label className="flex items-center gap-2">
          <Award className="h-4 w-4 text-slate-500" />
          Speaker Awards
        </Label>
        <Switch
          checked={state.enabled}
          onCheckedChange={(checked) => update({ enabled: checked })}
          data-testid="switch-speaker-awards"
        />
      </div>

      {grants && (
        <div className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2" data-testid="list-speaker-award-grants">
          <p className="text-sm font-medium text-slate-700">Awards granted at event start</p>
          {grants.map(g => (
            <div key={g.id} className="flex items-start gap-2 text-sm text-slate-600">
              {g.status === "granted"
                ? <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                : <XCircle className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />}
              <span>
                <span className="font-medium">{g.speaker_name || g.speaker_id}</span>
                {" — "}{grantStatusLabel[g.status] || g.status}
                {g.voucher_id && g.voucher_value ? `; voucher £${g.voucher_value}` : ""}
                {g.member_badge_id && g.badge_name ? `; badge "${g.badge_name}"` : ""}
                {g.detail ? ` (${g.detail})` : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {state.enabled && (
        <>
          <div className="flex items-start gap-2 text-xs text-slate-500">
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Awards are granted automatically when the event starts, to the speakers attached at that time.
              Training vouchers can only be awarded when the speaker is a member connected to an organisation
              (the voucher is credited to that organisation).
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="award-voucher-value" className="text-xs">Voucher amount (£)</Label>
              <Input
                id="award-voucher-value"
                type="number"
                min="0"
                step="0.01"
                value={state.default.voucher_value}
                onChange={(e) => updateDefault({ voucher_value: e.target.value })}
                placeholder="e.g. 100"
                data-testid="input-award-voucher-value"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="award-voucher-expiry" className="text-xs">Voucher expiry date</Label>
              <Input
                id="award-voucher-expiry"
                type="date"
                value={state.default.voucher_expiry}
                onChange={(e) => updateDefault({ voucher_expiry: e.target.value })}
                data-testid="input-award-voucher-expiry"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Badge</Label>
              <Select
                value={state.default.badge_id || NO_BADGE}
                onValueChange={(v) => updateDefault({ badge_id: v === NO_BADGE ? null : v })}
              >
                <SelectTrigger data-testid="select-award-badge">
                  <SelectValue placeholder="No badge" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_BADGE}>No badge</SelectItem>
                  {badges.map(b => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {state.default.voucher_value && !state.default.voucher_expiry && (
            <div className="flex items-center gap-2 text-xs text-warning-foreground">
              <AlertCircle className="w-4 h-4 text-warning" />
              <span>Set an expiry date — vouchers cannot be awarded without one.</span>
            </div>
          )}

          {(speakers || []).length === 0 ? (
            <p className="text-xs text-slate-500">No speakers selected yet. The award above will apply to speakers you add.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-600">Per-speaker awards</p>
              {(speakers || []).map(speaker => {
                const elig = eligibility[speaker.id];
                const override = state.overrides?.[speaker.id];
                const excluded = override?.excluded === true;
                const hasOverride = override && !excluded;
                const award = effectiveAward(state, speaker.id);
                return (
                  <div key={speaker.id} className="border border-slate-200 rounded-md p-3 space-y-2" data-testid={`speaker-award-row-${speaker.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-slate-800">{speaker.full_name}</span>
                      {elig && (
                        elig.voucher_eligible ? (
                          <Badge variant="outline" className="text-green-700 border-green-300">
                            Voucher eligible{elig.organization_name ? ` — ${elig.organization_name}` : ""}
                          </Badge>
                        ) : elig.badge_eligible ? (
                          <Badge variant="outline" className="text-amber-700 border-amber-300">Member, no organisation — badge only</Badge>
                        ) : (
                          <Badge variant="outline" className="text-slate-500">No linked member — no award possible</Badge>
                        )
                      )}
                      <div className="ml-auto flex items-center gap-2">
                        {!excluded && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => (hasOverride ? clearOverride(speaker.id) : updateOverride(speaker.id, {}))}
                            data-testid={`button-award-override-${speaker.id}`}
                          >
                            {hasOverride ? "Use default" : "Override"}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => (excluded ? clearOverride(speaker.id) : update({ overrides: { ...state.overrides, [speaker.id]: { excluded: true } } }))}
                          data-testid={`button-award-exclude-${speaker.id}`}
                        >
                          {excluded ? "Include" : "Exclude"}
                        </Button>
                      </div>
                    </div>

                    {excluded ? (
                      <p className="text-xs text-slate-500">Excluded — this speaker receives no award.</p>
                    ) : hasOverride ? (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Voucher amount (£)</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={override.voucher_value ?? ""}
                            onChange={(e) => updateOverride(speaker.id, { voucher_value: e.target.value })}
                            placeholder={state.default.voucher_value || "Default"}
                            data-testid={`input-override-voucher-value-${speaker.id}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Voucher expiry</Label>
                          <Input
                            type="date"
                            value={override.voucher_expiry ?? ""}
                            onChange={(e) => updateOverride(speaker.id, { voucher_expiry: e.target.value })}
                            data-testid={`input-override-voucher-expiry-${speaker.id}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Badge</Label>
                          <Select
                            value={override.badge_id || NO_BADGE}
                            onValueChange={(v) => updateOverride(speaker.id, { badge_id: v === NO_BADGE ? null : v })}
                          >
                            <SelectTrigger data-testid={`select-override-badge-${speaker.id}`}>
                              <SelectValue placeholder="Default badge" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NO_BADGE}>Use default</SelectItem>
                              {badges.map(b => (
                                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">
                        {award.voucher_value && award.voucher_expiry ? `Voucher £${award.voucher_value} (expires ${award.voucher_expiry})` : "No voucher"}
                        {award.badge_id ? ` · Badge: ${badgeName(award.badge_id)}` : " · No badge"}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
