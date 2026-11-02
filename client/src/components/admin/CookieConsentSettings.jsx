import { useCallback, useEffect, useId, useState } from 'react';
import { Shield, Eye, Save, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { adminFetch } from '@/lib/adminFetch';

const tenantFields = ['title', 'description', 'privacyUrl', 'cookieUrl', 'language', 'analyticsEnabled'];
const platformFields = [...tenantFields, 'policyVersion', 'retentionDays', 'enabled', 'pilotTenantIds'];
const owns = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const pickOverrides = (value, platform) => Object.fromEntries(
  (platform ? platformFields : tenantFields).filter(key => owns(value || {}, key)).map(key => [key, value[key]])
);

async function readResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const details = data?.details || data?.errors;
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message;
    throw new Error([
      message || `Cookie consent request failed (HTTP ${response.status}).`,
      details ? (typeof details === 'string' ? details : JSON.stringify(details)) : '',
    ].filter(Boolean).join(' '));
  }
  return data;
}

function validSettings(data) {
  if (!data?.effective || typeof data.effective !== 'object' || Array.isArray(data.effective)
    || !data.overrides || typeof data.overrides !== 'object' || Array.isArray(data.overrides)) {
    throw new Error('The server returned incomplete cookie consent settings. Please retry before editing.');
  }
  return data;
}

// The iframe owns the SDK preview. This editor never imports or starts a tracking SDK.
export default function CookieConsentSettings({ platform = false, tenantId }) {
  const id = useId();
  const endpoint = platform ? '/api/platform/cookie-consent' : '/api/admin/cookie-consent';
  const [data, setData] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [search, setSearch] = useState('');
  const request = useCallback((options = {}) => platform
    ? fetch(endpoint, { ...options, credentials: 'include' })
    : adminFetch(endpoint, { ...options, credentials: 'include' }, tenantId),
  [endpoint, platform, tenantId]);

  const accept = useCallback(next => {
    setData(next);
    setOverrides(pickOverrides(next.overrides, platform));
  }, [platform]);

  const load = useCallback(async (signal) => {
    setLoading(true);
    setError('');
    try {
      const next = validSettings(await readResponse(await request({ signal })));
      if (!signal?.aborted) accept(next);
    } catch (err) {
      if (!signal?.aborted) setError(err.message || 'Unable to load cookie consent settings.');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [request, accept]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const effective = { ...data?.effective, ...overrides };
  const dirty = !!data && JSON.stringify(overrides) !== JSON.stringify(pickOverrides(data.overrides, platform));
  const change = (field, value) => {
    setOverrides(previous => ({ ...previous, [field]: value }));
    setNotice('');
    setError('');
  };
  const save = async (reset = false) => {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    let written = false;
    try {
      const nextOverrides = reset ? {} : pickOverrides(overrides, platform);
      if (!reset && platform && (!Number.isInteger(effective.retentionDays)
        || effective.retentionDays < 7 || effective.retentionDays > 730)) {
        throw new Error('Retention must be a whole number between 7 and 730 days.');
      }
      const result = await readResponse(await request({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: nextOverrides }),
      }));
      written = true;
      const next = validSettings(result?.effective && result?.overrides
        ? result : await readResponse(await request()));
      // PUT may omit ancillary fields such as the read-only GA ID or tenant readiness.
      accept({ ...data, ...next });
      setConfirmReset(false);
      setNotice(reset
        ? (platform ? 'Platform overrides cleared. Built-in defaults now apply.' : 'Site overrides cleared. This site now inherits platform defaults.')
        : 'Cookie consent settings saved.');
    } catch (err) {
      if (written) {
        setData(null);
        setError(`Settings were saved, but the effective configuration could not be refreshed. Reload before editing again. ${err.message}`);
      } else {
        setError(`Settings were not saved. ${err.message || 'Please try again.'}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const muted = platform ? 'text-muted-foreground' : 'text-slate-400';
  const panel = platform ? 'border bg-muted/30' : 'border border-slate-700 bg-slate-900/40';
  const control = platform ? '' : 'bg-slate-900/50 border-slate-600 text-slate-100';
  const fieldId = field => `${id}-${field}`;
  const inherited = field => !platform && (
    <span className={`text-xs font-normal ${muted}`}>
      {owns(overrides, field) ? 'Site override' : 'Inherited from platform'}
    </span>
  );
  const textField = (field, label, help, type = 'text') => (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={fieldId(field)}>{label}</Label>{inherited(field)}
      </div>
      <Input id={fieldId(field)} type={type} value={effective[field] ?? ''}
        onChange={event => change(field, type === 'number'
          ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value)}
        min={type === 'number' ? 7 : undefined} max={type === 'number' ? 730 : undefined}
        step={type === 'number' ? 1 : undefined}
        aria-describedby={help ? fieldId(`${field}-help`) : undefined} className={control} />
      {help && <p id={fieldId(`${field}-help`)} className={`text-xs leading-relaxed ${muted}`}>{help}</p>}
    </div>
  );
  const toggle = (field, label, help) => (
    <div className={`flex items-start justify-between gap-5 rounded-lg p-4 ${panel}`}>
      <div className="space-y-1">
        <Label htmlFor={fieldId(field)}>{label}</Label>
        <p id={fieldId(`${field}-help`)} className={`text-sm ${muted}`}>{help}</p>
        {inherited(field)}
      </div>
      <Switch id={fieldId(field)} checked={effective[field] === true}
        onCheckedChange={value => change(field, value)}
        aria-describedby={fieldId(`${field}-help`)} className="shrink-0" />
    </div>
  );
  const pilots = Array.isArray(effective.pilotTenantIds) ? effective.pilotTenantIds : [];
  const tenants = data?.tenants || [];
  const filteredTenants = tenants.filter(tenant => tenant.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <Card id="cookie-consent-settings" className={platform ? '' : 'bg-slate-800/50 border-slate-700 text-slate-200'}>
      <CardHeader>
        <CardTitle className={`flex items-center gap-2 ${platform ? '' : 'text-white'}`}>
          <Shield className="h-5 w-5" aria-hidden="true" /> Cookie consent
        </CardTitle>
        <CardDescription className={muted}>
          {platform ? 'Set the shared CookieYes defaults and control the rollout across tenant sites.'
            : 'Customize CookieYes for your site, or inherit the platform defaults. These settings save separately from other tenant settings.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6" aria-busy={loading || saving}>
        {error && <div role="alert" className={`rounded-lg border p-4 text-sm ${platform ? 'border-destructive/40 text-destructive' : 'border-red-800 text-red-300'}`}>
          <p>{error}</p>
          {!data && <Button type="button" variant="outline" className="mt-3" onClick={() => load()}>Retry loading settings</Button>}
        </div>}
        {loading ? <div role="status" aria-label="Loading cookie consent settings" className="space-y-4 motion-safe:animate-pulse">
          <div className={`h-16 rounded-lg ${platform ? 'bg-muted' : 'bg-slate-700/60'}`} />
          <div className={`h-36 rounded-lg ${platform ? 'bg-muted' : 'bg-slate-700/60'}`} />
        </div> : data && <>
          <div className={`rounded-lg p-4 text-sm ${panel}`}>
            <p className="font-medium">{platform ? 'Platform defaults' : Object.keys(overrides).length ? 'This site has custom settings' : 'Following platform defaults'}</p>
            <p className={`mt-1 ${muted}`}>{platform
              ? 'Tenants can override banner copy, policy links and analytics preference. Rollout, policy version and retention stay under platform control.'
              : 'Only fields you change are saved as overrides. Unchanged fields continue to follow platform updates.'}</p>
          </div>
          <fieldset disabled={saving} className="min-w-0 space-y-6">
            {platform && <section className="space-y-4" aria-label="Platform rollout">
              <h3 className="text-sm font-semibold">Rollout & governance</h3>
              {toggle('enabled', 'Enable platform tracking', 'Off disables all tracking across the platform. When on, the pilot tenant list gates activation; visitor consent is still required.')}
              <div className={`rounded-lg p-4 ${panel}`}>
                <Label htmlFor={fieldId('pilot-search')}>Pilot tenants</Label>
                <p className={`mt-1 mb-3 text-sm ${muted}`}>{pilots.length} selected. Readiness and activation are reported by the server.</p>
                <Input id={fieldId('pilot-search')} value={search} onChange={event => setSearch(event.target.value)}
                  placeholder="Find a tenant" className={control} />
                <div className="mt-3 max-h-64 space-y-2 overflow-y-auto">
                  {filteredTenants.map(tenant => <label key={tenant.id} className={`flex cursor-pointer items-center gap-3 rounded-md p-3 ${panel}`}>
                    <input type="checkbox" className="h-4 w-4 shrink-0 accent-current" checked={pilots.includes(tenant.id)}
                      onChange={event => change('pilotTenantIds', event.target.checked ? [...pilots, tenant.id] : pilots.filter(value => value !== tenant.id))} />
                    <span className="min-w-0 flex-1 break-words text-sm">{tenant.name}</span>
                    <span className={`text-right text-xs ${muted}`}>{tenant.complete ? 'Complete' : 'Incomplete'}<br />{tenant.active ? 'Active' : 'Inactive'}</span>
                  </label>)}
                  {!filteredTenants.length && <div className={`rounded-md border border-dashed p-5 text-sm ${muted}`}>
                    {tenants.length ? 'No tenants match your search.' : 'No tenants are available for the pilot yet.'}
                  </div>}
                  {pilots.filter(value => !tenants.some(tenant => tenant.id === value)).map(value =>
                    <label key={value} className={`flex items-center gap-3 p-3 text-xs ${muted}`}>
                      <input type="checkbox" checked onChange={() => change('pilotTenantIds', pilots.filter(item => item !== value))} />
                      <span className="break-all">Unavailable tenant: {value} (selected)</span>
                    </label>)}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {textField('policyVersion', 'Policy version', 'Version used to identify the current consent policy.')}
                {textField('retentionDays', 'Consent retention (days)', 'A whole number from 7 to 730.', 'number')}
              </div>
            </section>}
            <section className="space-y-4" aria-label="Banner content">
              <h3 className="text-sm font-semibold">Banner content</h3>
              {textField('title', 'Banner title')}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor={fieldId('description')}>Banner description</Label>{inherited('description')}
                </div>
                <textarea id={fieldId('description')} rows={4} value={effective.description ?? ''}
                  onChange={event => change('description', event.target.value)}
                  className={`flex w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${platform ? 'border-input bg-background' : control}`} />
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {textField('privacyUrl', 'Privacy policy URL', 'Use a same-origin path such as /privacy or an https:// URL.')}
                {textField('cookieUrl', 'Cookie policy URL', 'Use a same-origin path such as /cookies or an https:// URL.')}
              </div>
              <div className="space-y-2">
                <Label htmlFor={fieldId('language')}>Language</Label>
                <Input id={fieldId('language')} value="English (en)" readOnly className={control} />
                <p className={`text-xs ${muted}`}>English is the only supported language in this version.</p>
              </div>
            </section>
            <section className="space-y-4" aria-label="Analytics">
              <h3 className="text-sm font-semibold">Analytics</h3>
              {toggle('analyticsEnabled', 'Allow consent-based analytics', 'Analytics runs only when platform tracking is enabled, this site passes the pilot gate, a GA4 ID is configured, and the visitor accepts analytics cookies. This switch alone never starts tracking.')}
              {!platform && <div className="space-y-2">
                <Label htmlFor={fieldId('ga4')}>Existing GA4 measurement ID</Label>
                <Input id={fieldId('ga4')} value={data.ga4MeasurementId || 'Not configured'} readOnly className={`${control} font-mono`} />
                <p className={`text-xs ${muted}`}>Read-only here. Manage the measurement ID in your existing analytics settings.</p>
              </div>}
            </section>
          </fieldset>
          <section className={`rounded-lg p-4 ${panel}`} aria-label="Isolated preview">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold"><Eye className="h-4 w-4" aria-hidden="true" /> Isolated preview</h3>
                <p className={`mt-1 text-xs ${muted}`}>Shows your unsaved effective configuration. No audit events or tracking are sent.</p>
              </div>
              <Button type="button" variant="outline" onClick={() => setShowPreview(value => !value)} aria-expanded={showPreview} aria-controls={fieldId('preview')}>
                {showPreview ? 'Close preview' : 'Open preview'}
              </Button>
            </div>
            {showPreview && <iframe id={fieldId('preview')} title="Cookie consent sandbox preview"
              src={`/cookie-consent-preview.html#${encodeURIComponent(JSON.stringify({ config: effective }))}`}
              sandbox="allow-scripts" referrerPolicy="no-referrer"
              className="mt-4 h-[440px] w-full rounded-lg border border-slate-600" />}
          </section>
          {confirmReset && <div role="alert" className={`space-y-3 rounded-lg p-4 ${panel}`}>
            <p className="text-sm">{platform ? 'Clear all platform overrides and restore built-in defaults?' : 'Remove all site overrides and use the current platform defaults?'} Unsaved edits will also be discarded.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" disabled={saving} onClick={() => save(true)}>Confirm reset</Button>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setConfirmReset(false)}>Cancel</Button>
            </div>
          </div>}
          {notice && <p role="status" className={`text-sm ${platform ? 'text-emerald-700 dark:text-emerald-300' : 'text-emerald-300'}`}>{notice}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-current/10 pt-4">
            <Button type="button" variant="outline" disabled={saving || confirmReset || !Object.keys(overrides).length}
              onClick={() => setConfirmReset(true)}>
              <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />{platform ? 'Reset platform defaults' : 'Use platform defaults'}
            </Button>
            <Button type="button" disabled={saving || !dirty || confirmReset} onClick={() => save()}>
              <Save className="mr-2 h-4 w-4" aria-hidden="true" />{saving ? 'Saving consent settings…' : 'Save consent settings'}
            </Button>
          </div>
        </>}
      </CardContent>
    </Card>
  );
}
