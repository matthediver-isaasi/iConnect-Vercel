import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2, ArrowLeft, ArrowRight } from "lucide-react";

const PERSONAS = [
  { code: "gym", label: "Gym / fitness club" },
  { code: "professional_body", label: "Professional body / institute" },
  { code: "charity", label: "Charity / nonprofit" },
  { code: "trade_association", label: "Trade association" },
  { code: "club_society", label: "Club or society" },
  { code: "faith_community", label: "Faith community" },
  { code: "education", label: "Education / alumni" },
  { code: "other", label: "Something else" },
];

const MODULES = [
  { code: "events", label: "Events" },
  { code: "memberships", label: "Memberships" },
  { code: "resources", label: "Resources" },
  { code: "articles", label: "Articles / blog" },
  { code: "fundraising", label: "Fundraising" },
  { code: "forum", label: "Discussion forum" },
];

const INTEGRATIONS = [
  { code: "stripe", label: "Stripe (payments)" },
  { code: "xero", label: "Xero (accounting)" },
  { code: "quickbooks", label: "QuickBooks (accounting)" },
  { code: "zoom", label: "Zoom (online events)" },
];

const INTENT_OPTIONS = [
  { value: "connect_now", label: "I want to connect this now" },
  { value: "maybe_later", label: "Maybe later" },
  { value: "not_needed", label: "Not needed" },
];

const STEPS = ["Persona", "Modules", "Integrations", "Branding", "Custom domain"];

export default function OnboardingWizard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [tenant, setTenant] = useState(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [data, setData] = useState({
    persona: "",
    modules: ["events", "memberships"],
    integration_intent: {},
    branding: { primary_color: "#2563eb", tagline: "", logo_url: "" },
    custom_domain: { intent: "maybe_later", domain: "" },
  });

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch("/api/admin/onboarding", { credentials: "include" });
        if (resp.status === 401 || resp.status === 403) {
          navigate("/admin/login");
          return;
        }
        const json = await resp.json();
        if (json?.tenant) {
          setTenant(json.tenant);
          if (json.tenant.onboarding_status === "complete") {
            navigate("/admin/dashboard");
            return;
          }
          if (json.tenant.onboarding_data && Object.keys(json.tenant.onboarding_data).length) {
            setData(prev => ({ ...prev, ...json.tenant.onboarding_data }));
          }
        }
      } catch (err) {
        setError("Could not load onboarding state.");
      } finally {
        setLoading(false);
      }
    })();
  }, [navigate]);

  const persistPartial = async (patch) => {
    setSaving(true);
    try {
      await fetch("/api/admin/onboarding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(patch),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleNext = async () => {
    setError("");
    if (step === 0 && !data.persona) { setError("Please pick the option that best fits your group."); return; }
    if (step === 1 && data.modules.length === 0) { setError("Please pick at least one module."); return; }
    await persistPartial(data);
    setStep(s => Math.min(STEPS.length - 1, s + 1));
  };

  const handleBack = () => setStep(s => Math.max(0, s - 1));

  const handleFinish = async () => {
    setError("");
    setSubmitting(true);
    try {
      const resp = await fetch("/api/admin/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      const json = await resp.json();
      if (!resp.ok) {
        setError(json.error || "Failed to finish setup.");
        return;
      }
      navigate("/admin/dashboard");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const setIntent = (type, intent) => setData(d => ({
    ...d,
    integration_intent: { ...d.integration_intent, [type]: intent },
  }));

  const toggleModule = (code) => setData(d => ({
    ...d,
    modules: d.modules.includes(code) ? d.modules.filter(c => c !== code) : [...d.modules, code],
  }));

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Welcome{tenant?.name ? `, ${tenant.name}` : ""}</h1>
            <p className="text-sm text-muted-foreground">Let's get your workspace set up — it'll take a couple of minutes.</p>
          </div>
          <div className="text-sm text-muted-foreground" data-testid="text-wizard-progress">
            Step {step + 1} of {STEPS.length}
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{STEPS[step]}</CardTitle>
            <CardDescription>
              {step === 0 && "Which best describes your organisation? This shapes the sample content we'll set up for you."}
              {step === 1 && "Pick the modules you expect to use. You can switch any of these on or off later."}
              {step === 2 && "Tell us which third-party tools you plan to connect. We'll guide you through them after."}
              {step === 3 && "Add your colour and (optionally) a logo and tagline. You can refine these any time."}
              {step === 4 && "Will you want a custom domain (like members.your-domain.com) for your portal?"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {step === 0 && (
              <RadioGroup value={data.persona} onValueChange={v => setData(d => ({ ...d, persona: v }))}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {PERSONAS.map(p => (
                    <Label
                      key={p.code}
                      htmlFor={`persona-${p.code}`}
                      className="flex items-center gap-2 rounded-md border p-3 hover-elevate cursor-pointer"
                    >
                      <RadioGroupItem id={`persona-${p.code}`} value={p.code} data-testid={`radio-persona-${p.code}`} />
                      <span>{p.label}</span>
                    </Label>
                  ))}
                </div>
              </RadioGroup>
            )}

            {step === 1 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {MODULES.map(m => (
                  <Label
                    key={m.code}
                    htmlFor={`module-${m.code}`}
                    className="flex items-center gap-2 rounded-md border p-3 hover-elevate cursor-pointer"
                  >
                    <Checkbox
                      id={`module-${m.code}`}
                      checked={data.modules.includes(m.code)}
                      onCheckedChange={() => toggleModule(m.code)}
                      data-testid={`checkbox-module-${m.code}`}
                    />
                    <span>{m.label}</span>
                  </Label>
                ))}
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                {INTEGRATIONS.map(intg => (
                  <div key={intg.code} className="space-y-2">
                    <div className="text-sm font-medium">{intg.label}</div>
                    <RadioGroup
                      value={data.integration_intent[intg.code] || "maybe_later"}
                      onValueChange={v => setIntent(intg.code, v)}
                      className="grid grid-cols-1 sm:grid-cols-3 gap-2"
                    >
                      {INTENT_OPTIONS.map(opt => (
                        <Label
                          key={opt.value}
                          htmlFor={`intent-${intg.code}-${opt.value}`}
                          className="flex items-center gap-2 rounded-md border p-2 hover-elevate cursor-pointer text-sm"
                        >
                          <RadioGroupItem
                            id={`intent-${intg.code}-${opt.value}`}
                            value={opt.value}
                            data-testid={`radio-intent-${intg.code}-${opt.value}`}
                          />
                          {opt.label}
                        </Label>
                      ))}
                    </RadioGroup>
                  </div>
                ))}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="primary-color">Primary colour</Label>
                  <Input
                    id="primary-color"
                    type="color"
                    value={data.branding.primary_color}
                    onChange={e => setData(d => ({ ...d, branding: { ...d.branding, primary_color: e.target.value } }))}
                    className="h-10 w-24"
                    data-testid="input-branding-primary-color"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="logo-url">Logo URL (optional)</Label>
                  <Input
                    id="logo-url"
                    placeholder="https://…/logo.png"
                    value={data.branding.logo_url}
                    onChange={e => setData(d => ({ ...d, branding: { ...d.branding, logo_url: e.target.value } }))}
                    data-testid="input-branding-logo-url"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tagline">Tagline (optional)</Label>
                  <Textarea
                    id="tagline"
                    placeholder="One short sentence about your group"
                    value={data.branding.tagline}
                    onChange={e => setData(d => ({ ...d, branding: { ...d.branding, tagline: e.target.value } }))}
                    rows={2}
                    data-testid="input-branding-tagline"
                  />
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <RadioGroup
                  value={data.custom_domain.intent}
                  onValueChange={v => setData(d => ({ ...d, custom_domain: { ...d.custom_domain, intent: v } }))}
                >
                  {[
                    { value: "will_use", label: "Yes, I'll set up a custom domain" },
                    { value: "maybe_later", label: "Maybe later" },
                    { value: "not_needed", label: "No, the default subdomain is fine" },
                  ].map(opt => (
                    <Label
                      key={opt.value}
                      htmlFor={`domain-${opt.value}`}
                      className="flex items-center gap-2 rounded-md border p-3 hover-elevate cursor-pointer"
                    >
                      <RadioGroupItem id={`domain-${opt.value}`} value={opt.value} data-testid={`radio-domain-${opt.value}`} />
                      <span>{opt.label}</span>
                    </Label>
                  ))}
                </RadioGroup>
                {data.custom_domain.intent === "will_use" && (
                  <div className="space-y-2">
                    <Label htmlFor="domain-name">Domain you plan to use</Label>
                    <Input
                      id="domain-name"
                      placeholder="members.example.com"
                      value={data.custom_domain.domain}
                      onChange={e => setData(d => ({ ...d, custom_domain: { ...d.custom_domain, domain: e.target.value } }))}
                      data-testid="input-custom-domain"
                    />
                    <p className="text-xs text-muted-foreground">
                      We'll show you the DNS records to set up after you finish the wizard.
                    </p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter className="flex justify-between gap-2">
            <Button
              variant="outline"
              onClick={handleBack}
              disabled={step === 0 || submitting}
              data-testid="button-wizard-back"
            >
              <ArrowLeft className="w-4 h-4 mr-1" /> Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button onClick={handleNext} disabled={saving || submitting} data-testid="button-wizard-next">
                Next <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            ) : (
              <Button onClick={handleFinish} disabled={submitting} data-testid="button-wizard-finish">
                {submitting ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Finishing…</>) : (<><CheckCircle2 className="w-4 h-4 mr-2" />Finish setup</>)}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
