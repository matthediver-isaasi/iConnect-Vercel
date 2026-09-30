import { useEffect, useState } from "react";
import { AlertTriangle, Check, CheckCircle2, Copy, ExternalLink, Loader2, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { adminFetch } from "@/lib/adminFetch";

const EMPTY_MODE = {
  secret_configured: false,
  api_key_configured: false,
};

function normaliseSettings(settings) {
  return {
    url: settings?.url || "",
    events: Array.isArray(settings?.events) ? settings.events : [],
    modes: {
      live: { ...EMPTY_MODE, ...(settings?.modes?.live || {}) },
      test: { ...EMPTY_MODE, ...(settings?.modes?.test || {}) },
    },
  };
}

function ModeStatus({ mode, configured }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="border-slate-600 text-slate-300 capitalize">
        {mode}
      </Badge>
      <span className={configured.secret_configured ? "text-xs text-green-400" : "text-xs text-slate-500"}>
        Signing secret {configured.secret_configured ? "stored" : "not stored"}
      </span>
      <span className={configured.api_key_configured ? "text-xs text-green-400" : "text-xs text-slate-500"}>
        API key {configured.api_key_configured ? "configured" : "not configured"}
      </span>
    </div>
  );
}

function CheckResult({ mode, result }) {
  if (!result) return null;

  const checks = result.checks || {};
  const labels = {
    api_key_configured: "API key configured",
    endpoint_found: "Endpoint found",
    endpoint_enabled: "Endpoint enabled",
    events_complete: "Required events selected",
  };
  const successful = result.status === "configured";

  return (
    <div
      className={`rounded-md border p-3 ${successful ? "border-green-500/30 bg-green-500/10" : "border-warning/30 bg-warning/10"}`}
      data-testid={`stripe-membership-webhook-result-${mode}`}
    >
      <div className="flex items-start gap-2">
        {successful
          ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-400" />
          : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
        <div className="min-w-0 space-y-2">
          <p className={`text-sm font-medium ${successful ? "text-green-400" : "text-warning"}`}>
            {result.status === "configured"
              ? "Configuration found"
              : result.status === "unavailable"
                ? "Configuration check unavailable"
                : "Configuration incomplete"}
          </p>
          {result.message && <p className="text-xs text-slate-300">{result.message}</p>}
          <ul className="grid gap-1 text-xs text-slate-300 sm:grid-cols-2">
            {Object.entries(labels).map(([key, label]) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className={checks[key] ? "text-green-400" : "text-slate-500"}>
                  {checks[key] ? "Yes" : "No"}
                </span>
                {label}
              </li>
            ))}
          </ul>
          {Array.isArray(result.missing_events) && result.missing_events.length > 0 && (
            <div>
              <p className="text-xs font-medium text-warning">Missing events</p>
              <p className="mt-1 break-words font-mono text-xs text-slate-300">
                {result.missing_events.join(", ")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StripeMembershipWebhookSettings({
  settings,
  stripeEnabled,
  onSaved,
}) {
  const { toast } = useToast();
  const [current, setCurrent] = useState(() => normaliseSettings(settings));
  const [secrets, setSecrets] = useState({ live: "", test: "" });
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState({ live: false, test: false });
  const [results, setResults] = useState({ live: null, test: null });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCurrent(normaliseSettings(settings));
  }, [settings]);

  const copyUrl = async () => {
    if (!current.url) return;
    try {
      await navigator.clipboard.writeText(current.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast({ title: "Copied", description: "Membership webhook URL copied" });
    } catch {
      toast({ variant: "destructive", title: "Copy failed", description: "Could not copy the webhook URL" });
    }
  };

  const saveSecrets = async () => {
    const credentials = {};
    if (secrets.live.trim()) credentials.membership_webhook_secret = secrets.live.trim();
    if (secrets.test.trim()) credentials.test_membership_webhook_secret = secrets.test.trim();
    if (Object.keys(credentials).length === 0) return;

    setSaving(true);
    try {
      const response = await adminFetch("/api/admin/integrations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integration_type: "stripe",
          credentials,
          is_enabled: stripeEnabled,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.success === false) {
        throw new Error(data.error || data.message || "Failed to save webhook signing secrets");
      }

      const savedLive = Boolean(credentials.membership_webhook_secret);
      const savedTest = Boolean(credentials.test_membership_webhook_secret);
      setCurrent((previous) => ({
        ...previous,
        modes: {
          live: {
            ...previous.modes.live,
            secret_configured: savedLive || previous.modes.live.secret_configured,
          },
          test: {
            ...previous.modes.test,
            secret_configured: savedTest || previous.modes.test.secret_configured,
          },
        },
      }));
      setSecrets({ live: "", test: "" });
      setResults({ live: null, test: null });
      toast({ title: "Saved", description: "Stripe membership webhook signing secrets saved" });
      await onSaved?.();
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Save failed",
        description: error.message || "Failed to save webhook signing secrets",
      });
    } finally {
      setSaving(false);
    }
  };

  const checkConfiguration = async (mode) => {
    setChecking((previous) => ({ ...previous, [mode]: true }));
    setResults((previous) => ({ ...previous, [mode]: null }));
    try {
      const response = await adminFetch("/api/admin/stripe-membership-webhooks", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || data.message || `Failed to check ${mode} configuration`);
      }
      setResults((previous) => ({ ...previous, [mode]: data }));
    } catch (error) {
      setResults((previous) => ({
        ...previous,
        [mode]: {
          mode,
          status: "unavailable",
          checks: {},
          missing_events: [],
          message: error.message || `Failed to check ${mode} configuration`,
        },
      }));
    } finally {
      setChecking((previous) => ({ ...previous, [mode]: false }));
    }
  };

  const hasChanges = Boolean(secrets.live.trim() || secrets.test.trim());

  return (
    <div
      className="rounded-lg border border-slate-700 bg-slate-900/50 p-4"
      data-testid="card-stripe-membership-webhook"
    >
      <div className="mb-4">
        <h4 className="text-sm font-medium text-white">Membership payment notifications</h4>
        <p className="mt-1 text-xs text-slate-400">
          Configure Stripe webhooks so membership payment and subscription changes can be processed reliably.
        </p>
      </div>

      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="stripe-membership-webhook-url" className="text-slate-300">Server webhook URL</Label>
          <div className="flex gap-2">
            <Input
              id="stripe-membership-webhook-url"
              readOnly
              value={current.url}
              placeholder="Webhook URL is not available"
              className="min-w-0 bg-slate-800 font-mono text-xs text-white"
              data-testid="input-stripe-membership-webhook-url"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={copyUrl}
              disabled={!current.url}
              aria-label="Copy membership webhook URL"
              data-testid="button-copy-stripe-membership-webhook-url"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          {!current.url && (
            <p className="text-xs text-warning">
              The server has not provided a membership webhook URL yet. Refresh after server setup is complete.
            </p>
          )}
        </div>

        <div>
          <p className="text-xs font-medium text-slate-300">Required snapshot events from your own Stripe account</p>
          {current.events.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {current.events.map((event) => (
                <Badge key={event} variant="outline" className="border-slate-600 font-mono text-xs text-slate-300">
                  {event}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-warning">Required event details are not available from the server yet.</p>
          )}
        </div>

        <div className="rounded-md border border-slate-700 bg-slate-800/50 p-3 text-xs text-slate-300">
          <p className="font-medium text-white">Setup in Stripe</p>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>Open Stripe Dashboard, then Developers or Workbench, and choose Webhooks.</li>
            <li>Create an endpoint for events on your own account and paste the exact server URL above.</li>
            <li>Select every required snapshot event shown above.</li>
            <li>Register the URL separately in live mode and test mode if you use both.</li>
            <li>Reveal each endpoint signing secret, copy it safely, and save it in the matching field below.</li>
          </ol>
          <a
            href="/guides/stripe-membership-payments.html"
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-purple-400 hover:underline"
          >
            Open the tenant-admin setup guide
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {(["live", "test"]).map((mode) => {
          const configured = current.modes[mode];
          const hasUnsavedSecret = Boolean(secrets[mode].trim());
          return (
            <div key={mode} className="space-y-3 rounded-md border border-slate-700 p-3">
              <ModeStatus mode={mode} configured={configured} />
              <div className="space-y-2">
                <Label htmlFor={`stripe-membership-webhook-secret-${mode}`} className="text-slate-300 capitalize">
                  {mode} endpoint signing secret
                </Label>
                <Input
                  id={`stripe-membership-webhook-secret-${mode}`}
                  type="password"
                  autoComplete="new-password"
                  value={secrets[mode]}
                  onChange={(event) => setSecrets((previous) => ({ ...previous, [mode]: event.target.value }))}
                  placeholder={configured.secret_configured ? "Stored; enter a replacement only" : "whsec_..."}
                  className="bg-slate-800 text-white placeholder:text-slate-500"
                  data-testid={`input-stripe-membership-webhook-secret-${mode}`}
                />
                <p className="text-xs text-slate-500">
                  Leave blank to keep the stored secret. Stored values are never displayed or submitted again.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => checkConfiguration(mode)}
                disabled={!configured.secret_configured || hasUnsavedSecret || checking[mode]}
                data-testid={`button-check-stripe-membership-webhook-${mode}`}
              >
                {checking[mode] && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Check {mode} configuration
              </Button>
              {!configured.secret_configured && (
                <p className="text-xs text-slate-500">Save a {mode} signing secret before checking this configuration.</p>
              )}
              {hasUnsavedSecret && configured.secret_configured && (
                <p className="text-xs text-slate-500">Save the new secret before checking this configuration.</p>
              )}
              <CheckResult mode={mode} result={results[mode]} />
            </div>
          );
        })}

        <Button
          type="button"
          onClick={saveSecrets}
          disabled={!hasChanges || saving}
          data-testid="button-save-stripe-membership-webhook-secrets"
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save signing secrets
        </Button>

        <div className="flex items-start gap-2 rounded-md border border-slate-700 bg-slate-800/50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-xs text-slate-400">
            Configuration checks only read your saved Stripe settings. They do not create a webhook endpoint,
            take payments, or prove that Stripe has delivered an event or that a stored signing secret matches
            the endpoint.
          </p>
        </div>
      </div>
    </div>
  );
}