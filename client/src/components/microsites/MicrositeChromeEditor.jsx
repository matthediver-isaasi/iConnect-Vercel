import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { adminFetch } from "@/lib/adminFetch";
import {
  Loader2, Palette, Image as ImageIcon, PanelTop, LogIn, UserCircle,
  Rows3, Share2, PanelBottom, AtSign, Upload,
} from "lucide-react";
import {
  GradientStopsEditor,
  HeaderLinkControls,
  SecondaryBarControls,
  FooterControls,
  hydrateSecondaryBarConfig,
  hydrateFooterConfig,
  getHeaderGradientStops,
  DEFAULT_HEADER_GRADIENT_STOPS,
  DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS,
} from "@/components/branding/brandingShared";

/**
 * Task #2525: visual branding controls for a microsite's header/footer chrome.
 *
 * Ten cards (Colors, Logo, Header Logo, Header Gradient, Login Button, Member
 * Area Button, Secondary Bar, Link Previews, Footer, Social Icon Colors), each
 * with an "Override" switch. Override OFF = the microsite inherits the tenant
 * value (keys are stripped on save, matching the existing empty-falls-back
 * merge). Override ON = the card's values are saved as microsite overrides,
 * prefilled from the tenant's current branding where available.
 *
 * Storage:
 *  - header cards -> microsite.header_config (gradientStops, loginLink,
 *    memberAreaLink, secondaryBar keys; other keys preserved untouched)
 *  - footer card  -> microsite.footer_config (managed keys only)
 *  - everything else -> microsite.branding_config (whitelisted server-side)
 */

// Full managed footer key set — mirrors every option /admin/branding exposes
// for footer_config (plus the CTA keys it hydrates), so a microsite override
// can express anything the tenant footer can.
const FOOTER_KEYS = [
  "columns", "columnAlignments", "ctaText", "ctaButtonText", "ctaLink",
  "newsletterText", "gradientColors", "backgroundColor", "textColor",
  "address", "contact", "legalText", "termsAndConditionsUrl", "privacyPolicyUrl",
];

function hasVal(v) {
  if (v === null || v === undefined || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

// Recursively drop empty strings / arrays / objects so overrides only persist
// keys the admin actually filled in. Booleans and numbers (including false/0)
// are always kept. Returns undefined when nothing remains.
function pruneEmpty(v) {
  if (v === null || v === undefined || v === "") return undefined;
  if (Array.isArray(v)) {
    const arr = v.map(pruneEmpty).filter((x) => x !== undefined);
    return arr.length > 0 ? arr : undefined;
  }
  if (typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const p = pruneEmpty(val);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return v;
}

async function readJson(res) {
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

function OverrideToggle({ checked, onChange, testId }) {
  return (
    <div className="flex items-center gap-2 flex-shrink-0">
      <span className="text-xs text-muted-foreground">Override</span>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </div>
  );
}

function ChromeCard({ icon: Icon, title, description, overridden, onToggle, testId, children }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon className="w-5 h-5" />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <OverrideToggle checked={overridden} onChange={onToggle} testId={testId} />
        </div>
      </CardHeader>
      {overridden ? (
        <CardContent className="space-y-4">{children}</CardContent>
      ) : (
        <CardContent>
          <p className="text-sm text-muted-foreground">Inheriting the tenant branding for this section.</p>
        </CardContent>
      )}
    </Card>
  );
}

function ColorField({ label, value, onChange, placeholder, testId, hint }) {
  return (
    <div className="space-y-2">
      <Label className="">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value || "#5C0085"}
          onChange={(e) => onChange(e.target.value)}
          className="w-10 h-10 rounded cursor-pointer flex-shrink-0"
          data-testid={`${testId}-picker`}
        />
        <Input
          type="text"
          placeholder={placeholder || "#5C0085"}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          data-testid={testId}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ImageField({ label, value, onChange, hint, testIdPrefix, toast }) {
  const inputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("folder", "branding");
      const res = await adminFetch("/api/integrations/upload-file", {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      const data = await readJson(res);
      onChange(data.file_url);
    } catch (err) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <Label className="">{label}</Label>
      {value && (
        <div className="rounded-lg border bg-muted p-3 inline-block">
          <img src={value} alt={label} className="max-h-16 max-w-[200px] object-contain" data-testid={`img-${testIdPrefix}`} />
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={handleUpload} data-testid={`file-${testIdPrefix}`} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className=""
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          data-testid={`button-upload-${testIdPrefix}`}
        >
          {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
          Upload image
        </Button>
        <Input
          type="text"
          placeholder="https://…"
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 min-w-[200px]"
          data-testid={`input-${testIdPrefix}-url`}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function MicrositeChromeEditor({ microsite }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Tenant defaults (no prefix -> tenant-level merged branding) used to
  // prefill a card the first time its Override switch is turned on.
  const { data: tenantBranding } = useQuery({
    queryKey: ["ms-tenant-branding-defaults"],
    queryFn: async () => {
      const res = await fetch("/api/public/tenant-branding", { credentials: "include" });
      const data = await readJson(res);
      return data.branding || {};
    },
    staleTime: 60_000,
  });

  const buildInitial = (ms) => {
    const bc = ms.branding_config || {};
    const hc = ms.header_config || {};
    const fc = ms.footer_config || {};
    return {
      overrides: {
        colors: hasVal(bc.primary_color) || hasVal(bc.secondary_color),
        logo: hasVal(bc.logo_url),
        headerLogo: hasVal(bc.header_logo_url),
        headerGradient: hasVal(hc.gradientStops) || hasVal(hc.gradientColors),
        topNavLabelWidth: hasVal(hc.topNavLabelMaxWidth),
        loginButton: hasVal(hc.loginLink),
        memberButton: hasVal(hc.memberAreaLink),
        secondaryBar: hasVal(hc.secondaryBar),
        linkPreviews: hasVal(bc.social_image_url) || hasVal(bc.tagline) || hasVal(bc.description),
        footer: FOOTER_KEYS.some((k) => pruneEmpty(fc[k]) !== undefined),
        socialIcons: hasVal(bc.headerSocialIconColor) || hasVal(bc.footerSocialIconColor),
      },
      branding: {
        primary_color: bc.primary_color || "",
        secondary_color: bc.secondary_color || "",
        logo_url: bc.logo_url || "",
        header_logo_url: bc.header_logo_url || "",
        social_image_url: bc.social_image_url || "",
        tagline: bc.tagline || "",
        description: bc.description || "",
        headerSocialIconColor: bc.headerSocialIconColor || "",
        footerSocialIconColor: bc.footerSocialIconColor || "",
      },
      header: {
        // Legacy microsites may store gradientColors (plain color array)
        // instead of gradientStops — hydrate both shapes, like /admin/branding.
        gradientStops: (hasVal(hc.gradientStops) || hasVal(hc.gradientColors))
          ? getHeaderGradientStops(hc)
          : [],
        topNavLabelMaxWidth: hc.topNavLabelMaxWidth ?? "",
        loginLink: (hc.loginLink && typeof hc.loginLink === "object") ? hc.loginLink : {},
        memberAreaLink: (hc.memberAreaLink && typeof hc.memberAreaLink === "object") ? hc.memberAreaLink : {},
        secondaryBar: (hc.secondaryBar && typeof hc.secondaryBar === "object")
          ? hydrateSecondaryBarConfig(hc.secondaryBar)
          : {},
      },
      footer: hydrateFooterConfig(fc, { withDefaults: false }),
    };
  };

  const [state, setState] = useState(() => buildInitial(microsite));
  const [lastLoadedId, setLastLoadedId] = useState(microsite.id);
  if (lastLoadedId !== microsite.id) {
    setState(buildInitial(microsite));
    setLastLoadedId(microsite.id);
  }

  const { overrides, branding, header, footer } = state;
  const setOverride = (key, on) => setState((s) => ({ ...s, overrides: { ...s.overrides, [key]: on } }));
  const setBranding = (patch) => setState((s) => ({ ...s, branding: { ...s.branding, ...patch } }));
  const setHeader = (patch) => setState((s) => ({ ...s, header: { ...s.header, ...patch } }));
  const setFooter = (patch) => setState((s) => ({ ...s, footer: { ...s.footer, ...patch } }));

  const tb = tenantBranding || {};
  const thc = tb.headerConfig || {};
  const tfc = tb.footerConfig || {};
  const tbc = tb.brandingConfig || {};

  // Prefill a card from tenant branding the first time it is switched on.
  const toggleWithSeed = (key, on, seed) => {
    setOverride(key, on);
    if (on) seed();
  };

  const seedColors = () => setBranding({
    primary_color: branding.primary_color || tb.primaryColor || "#5C0085",
    secondary_color: branding.secondary_color || tb.secondaryColor || "",
  });
  const seedLogo = () => setBranding({ logo_url: branding.logo_url || microsite.logo_url || tb.logoUrl || "" });
  const seedHeaderLogo = () => setBranding({ header_logo_url: branding.header_logo_url || tb.headerLogoUrl || "" });
  const seedHeaderGradient = () => setHeader({
    gradientStops: header.gradientStops.length > 0
      ? header.gradientStops
      : (Array.isArray(thc.gradientStops) && thc.gradientStops.length > 0 ? thc.gradientStops : DEFAULT_HEADER_GRADIENT_STOPS),
  });
  const seedTopNavLabelWidth = () => setHeader({
    topNavLabelMaxWidth: header.topNavLabelMaxWidth || thc.topNavLabelMaxWidth || "",
  });
  const seedLogin = () => setHeader({
    loginLink: hasVal(header.loginLink) ? header.loginLink : { ...(thc.loginLink || {}) },
  });
  const seedMember = () => setHeader({
    memberAreaLink: hasVal(header.memberAreaLink) ? header.memberAreaLink : { ...(thc.memberAreaLink || {}) },
  });
  const seedSecondaryBar = () => setHeader({
    secondaryBar: hasVal(header.secondaryBar)
      ? header.secondaryBar
      : hydrateSecondaryBarConfig(
          thc.secondaryBar && typeof thc.secondaryBar === "object"
            ? thc.secondaryBar
            : { enabled: true }
        ),
  });
  const seedLinkPreviews = () => setBranding({
    tagline: branding.tagline || tb.tagline || "",
    description: branding.description || tb.description || "",
    social_image_url: branding.social_image_url || tb.socialImageUrl || "",
  });
  // Seed the footer card from the tenant footer config, keeping any values
  // already stored on the microsite.
  const seedFooter = () => setFooter(
    hydrateFooterConfig({ ...(tfc || {}), ...(pruneEmpty(footer) || {}) })
  );
  const seedSocialIcons = () => setBranding({
    headerSocialIconColor: branding.headerSocialIconColor || tbc.headerSocialIconColor || "#5C0085",
    footerSocialIconColor: branding.footerSocialIconColor || tbc.footerSocialIconColor || "#FFFFFF",
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // header_config: preserve unmanaged keys; managed keys follow the toggles.
      const headerOut = { ...(microsite.header_config || {}) };
      if (overrides.headerGradient && hasVal(header.gradientStops)) headerOut.gradientStops = header.gradientStops;
      else delete headerOut.gradientStops;
      const topNavLabelWidthNum = parseInt(header.topNavLabelMaxWidth, 10);
      if (overrides.topNavLabelWidth && Number.isFinite(topNavLabelWidthNum) && topNavLabelWidthNum > 0) {
        headerOut.topNavLabelMaxWidth = topNavLabelWidthNum;
      } else {
        delete headerOut.topNavLabelMaxWidth;
      }
      if (overrides.loginButton && hasVal(header.loginLink)) headerOut.loginLink = header.loginLink;
      else delete headerOut.loginLink;
      if (overrides.memberButton && hasVal(header.memberAreaLink)) headerOut.memberAreaLink = header.memberAreaLink;
      else delete headerOut.memberAreaLink;
      const prunedSecondaryBar = overrides.secondaryBar ? pruneEmpty(header.secondaryBar) : undefined;
      if (prunedSecondaryBar !== undefined) headerOut.secondaryBar = prunedSecondaryBar;
      else delete headerOut.secondaryBar;

      const footerOut = { ...(microsite.footer_config || {}) };
      for (const k of FOOTER_KEYS) {
        const pruned = overrides.footer ? pruneEmpty(footer[k]) : undefined;
        if (pruned !== undefined) footerOut[k] = pruned;
        else delete footerOut[k];
      }

      const brandingOut = {};
      if (overrides.colors) {
        if (hasVal(branding.primary_color)) brandingOut.primary_color = branding.primary_color;
        if (hasVal(branding.secondary_color)) brandingOut.secondary_color = branding.secondary_color;
      }
      if (overrides.logo && hasVal(branding.logo_url)) brandingOut.logo_url = branding.logo_url;
      if (overrides.headerLogo && hasVal(branding.header_logo_url)) brandingOut.header_logo_url = branding.header_logo_url;
      if (overrides.linkPreviews) {
        if (hasVal(branding.social_image_url)) brandingOut.social_image_url = branding.social_image_url;
        if (hasVal(branding.tagline)) brandingOut.tagline = branding.tagline;
        if (hasVal(branding.description)) brandingOut.description = branding.description;
      }
      if (overrides.socialIcons) {
        if (hasVal(branding.headerSocialIconColor)) brandingOut.headerSocialIconColor = branding.headerSocialIconColor;
        if (hasVal(branding.footerSocialIconColor)) brandingOut.footerSocialIconColor = branding.footerSocialIconColor;
      }

      const res = await adminFetch(`/api/admin/microsites?id=${microsite.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          header_config: headerOut,
          footer_config: footerOut,
          branding_config: brandingOut,
        }),
        credentials: "include",
      });
      return readJson(res);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-microsites"] });
      queryClient.invalidateQueries({ queryKey: ["public-microsite-branding"] });
      toast({ title: "Branding saved", description: "Microsite header, footer and branding overrides updated." });
    },
    onError: (e) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });

  const secondaryBar = header.secondaryBar || {};

  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">
        Style this microsite's header, footer and branding. Turn on "Override" for any section you
        want to customize — everything left off keeps using the tenant branding automatically.
      </p>

      {/* 1. Colors */}
      <ChromeCard
        icon={Palette}
        title="Colors"
        description="Primary and secondary brand colors used across microsite pages."
        overridden={overrides.colors}
        onToggle={(on) => toggleWithSeed("colors", on, seedColors)}
        testId="switch-override-colors"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ColorField label="Primary Color" value={branding.primary_color} onChange={(v) => setBranding({ primary_color: v })} testId="input-ms-primary-color" />
          <ColorField label="Secondary Color" value={branding.secondary_color} onChange={(v) => setBranding({ secondary_color: v })} testId="input-ms-secondary-color" />
        </div>
      </ChromeCard>

      {/* 2. Logo */}
      <ChromeCard
        icon={ImageIcon}
        title="Logo"
        description="Main logo shown on microsite pages (footer, previews)."
        overridden={overrides.logo}
        onToggle={(on) => toggleWithSeed("logo", on, seedLogo)}
        testId="switch-override-logo"
      >
        <ImageField label="Logo" value={branding.logo_url} onChange={(v) => setBranding({ logo_url: v })} testIdPrefix="ms-logo" toast={toast} />
      </ChromeCard>

      {/* 3. Header Logo */}
      <ChromeCard
        icon={PanelTop}
        title="Header Logo"
        description="Logo shown in the microsite page header. Falls back to the main logo if unset."
        overridden={overrides.headerLogo}
        onToggle={(on) => toggleWithSeed("headerLogo", on, seedHeaderLogo)}
        testId="switch-override-header-logo"
      >
        <ImageField label="Header Logo" value={branding.header_logo_url} onChange={(v) => setBranding({ header_logo_url: v })} testIdPrefix="ms-header-logo" toast={toast} />
      </ChromeCard>

      {/* 4. Header Gradient */}
      <ChromeCard
        icon={Palette}
        title="Header Gradient Colors"
        description="Background gradient of the microsite header bar."
        overridden={overrides.headerGradient}
        onToggle={(on) => toggleWithSeed("headerGradient", on, seedHeaderGradient)}
        testId="switch-override-header-gradient"
      >
        <div
          className="rounded-lg border h-10"
          style={{
            background: `linear-gradient(to right, ${(header.gradientStops.length > 0 ? header.gradientStops : DEFAULT_HEADER_GRADIENT_STOPS)
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((s) => `${s.color} ${s.position}%`)
              .join(", ")})`,
          }}
          data-testid="preview-ms-header-gradient"
        />
        <GradientStopsEditor
          stops={header.gradientStops.length > 0 ? header.gradientStops : DEFAULT_HEADER_GRADIENT_STOPS}
          onChange={(s) => setHeader({ gradientStops: s })}
          testIdPrefix="ms-header-gradient"
          tone="light"
        />
      </ChromeCard>

      {/* 4b. Top Navigation Bar label wrapping */}
      <ChromeCard
        icon={PanelTop}
        title="Top Navigation Bar"
        description="Cap the top bar menu label width so long labels wrap onto multiple lines."
        overridden={overrides.topNavLabelWidth}
        onToggle={(on) => toggleWithSeed("topNavLabelWidth", on, seedTopNavLabelWidth)}
        testId="switch-override-top-nav-label-width"
      >
        <div className="space-y-2">
          <Label>Label max width (px)</Label>
          <Input
            type="number"
            min="0"
            max="600"
            placeholder="No cap (single line)"
            value={header.topNavLabelMaxWidth ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              setHeader({ topNavLabelMaxWidth: val === "" ? "" : parseInt(val, 10) });
            }}
            data-testid="input-ms-top-nav-label-max-width"
          />
          <p className="text-sm text-muted-foreground">Cap each top bar label's width so long labels wrap onto multiple lines. Leave blank for single-line labels.</p>
        </div>
      </ChromeCard>

      {/* 5. Login Button */}
      {overrides.loginButton ? (
        <HeaderLinkControls
          config={header.loginLink}
          onChange={(patch) => setHeader({ loginLink: { ...header.loginLink, ...patch } })}
          title="Login Button (logged out)"
          description="Style of the Login item shown to logged-out visitors on microsite pages."
          defaultLabel="Login"
          testIdPrefix="ms-login-link"
          tone="light"
          previewBackgroundStops={header.gradientStops.length > 0 ? header.gradientStops : (thc.gradientStops || DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS)}
          headerExtra={<OverrideToggle checked onChange={(on) => setOverride("loginButton", on)} testId="switch-override-login-button" />}
        />
      ) : (
        <ChromeCard
          icon={LogIn}
          title="Login Button (logged out)"
          description="Style of the Login item shown to logged-out visitors on microsite pages."
          overridden={false}
          onToggle={(on) => toggleWithSeed("loginButton", on, seedLogin)}
          testId="switch-override-login-button"
        />
      )}

      {/* 6. Member Area Button */}
      {overrides.memberButton ? (
        <HeaderLinkControls
          config={header.memberAreaLink}
          onChange={(patch) => setHeader({ memberAreaLink: { ...header.memberAreaLink, ...patch } })}
          title="Member Area Button (logged in)"
          description="Style of the Member Area item shown to logged-in members on microsite pages."
          defaultLabel="Member Area"
          testIdPrefix="ms-member-area-link"
          tone="light"
          previewBackgroundStops={header.gradientStops.length > 0 ? header.gradientStops : (thc.gradientStops || DEFAULT_LOGIN_BUTTON_GRADIENT_STOPS)}
          headerExtra={<OverrideToggle checked onChange={(on) => setOverride("memberButton", on)} testId="switch-override-member-button" />}
        />
      ) : (
        <ChromeCard
          icon={UserCircle}
          title="Member Area Button (logged in)"
          description="Style of the Member Area item shown to logged-in members on microsite pages."
          overridden={false}
          onToggle={(on) => toggleWithSeed("memberButton", on, seedMember)}
          testId="switch-override-member-button"
        />
      )}

      {/* 7. Secondary Bar */}
      {overrides.secondaryBar ? (
        <SecondaryBarControls
          value={secondaryBar}
          onChange={(sb) => setHeader({ secondaryBar: sb })}
          headerLogoUrl={branding.header_logo_url || tb.headerLogoUrl || branding.logo_url || microsite.logo_url || tb.logoUrl || ""}
          siteName={microsite.name}
          primaryColor={branding.primary_color || tb.primaryColor}
          secondaryColor={branding.secondary_color || tb.secondaryColor}
          testIdPrefix="ms-secondary-bar"
          tone="light"
          title="Secondary Lower Navigation Bar"
          description="Optional second bar under the main header with its own height, colors and active-item indicator."
          headerExtra={<OverrideToggle checked onChange={(on) => setOverride("secondaryBar", on)} testId="switch-override-secondary-bar" />}
        />
      ) : (
        <ChromeCard
          icon={Rows3}
          title="Secondary Lower Navigation Bar"
          description="Optional second bar under the main header with its own height, colors and active-item indicator."
          overridden={false}
          onToggle={(on) => toggleWithSeed("secondaryBar", on, seedSecondaryBar)}
          testId="switch-override-secondary-bar"
        />
      )}

      {/* 8. Link Previews */}
      <ChromeCard
        icon={Share2}
        title="Link Previews (SEO & Social Sharing)"
        description="Image and text shown when microsite pages are shared on social media."
        overridden={overrides.linkPreviews}
        onToggle={(on) => toggleWithSeed("linkPreviews", on, seedLinkPreviews)}
        testId="switch-override-link-previews"
      >
        <ImageField
          label="Social Share Image"
          value={branding.social_image_url}
          onChange={(v) => setBranding({ social_image_url: v })}
          hint="Recommended size 1200×630. Shown when microsite pages are shared."
          testIdPrefix="ms-social-image"
          toast={toast}
        />
        <div className="space-y-2">
          <Label className="">Tagline</Label>
          <Input
            type="text"
            maxLength={120}
            placeholder="Inherits tenant tagline"
            value={branding.tagline}
            onChange={(e) => setBranding({ tagline: e.target.value })}
            className=""
            data-testid="input-ms-tagline"
          />
        </div>
        <div className="space-y-2">
          <Label className="">Description</Label>
          <Textarea
            rows={3}
            maxLength={300}
            placeholder="Inherits tenant description"
            value={branding.description}
            onChange={(e) => setBranding({ description: e.target.value })}
            className=""
            data-testid="input-ms-description"
          />
          <p className="text-xs text-muted-foreground">Shown in search results and link previews for this microsite's pages.</p>
        </div>
      </ChromeCard>

      {/* 9. Footer */}
      {overrides.footer ? (
        <FooterControls
          value={footer}
          onChange={(fc) => setState((s) => ({ ...s, footer: fc }))}
          testIdPrefix="ms-footer"
          tone="light"
          title="Footer Configuration"
          description="Columns, colors, address, contact details and legal text of the footer on microsite pages."
          headerExtra={<OverrideToggle checked onChange={(on) => setOverride("footer", on)} testId="switch-override-footer" />}
        />
      ) : (
        <ChromeCard
          icon={PanelBottom}
          title="Footer Configuration"
          description="Columns, colors, address, contact details and legal text of the footer on microsite pages."
          overridden={false}
          onToggle={(on) => toggleWithSeed("footer", on, seedFooter)}
          testId="switch-override-footer"
        />
      )}

      {/* 10. Social Icon Colors */}
      <ChromeCard
        icon={AtSign}
        title="Social Icon Colors"
        description="Colors of the social media icons in the microsite header and footer."
        overridden={overrides.socialIcons}
        onToggle={(on) => toggleWithSeed("socialIcons", on, seedSocialIcons)}
        testId="switch-override-social-icons"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <ColorField
            label="Header Icon Color"
            value={branding.headerSocialIconColor}
            onChange={(v) => setBranding({ headerSocialIconColor: v })}
            placeholder="#5C0085"
            testId="input-ms-header-social-color"
          />
          <ColorField
            label="Footer Icon Color"
            value={branding.footerSocialIconColor}
            onChange={(v) => setBranding({ footerSocialIconColor: v })}
            placeholder="#FFFFFF"
            testId="input-ms-footer-social-color"
          />
        </div>
      </ChromeCard>

      <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-chrome">
        {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
        Save branding
      </Button>
    </div>
  );
}
