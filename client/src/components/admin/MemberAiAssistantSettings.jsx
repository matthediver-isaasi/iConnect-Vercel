import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, ImagePlus, Loader2, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { adminFetch } from "@/lib/adminFetch";
import { resolveMemberAiLauncherStyle } from "@shared/memberAiLauncherColors.js";
import MemberAiResponsePolicy, { DEFAULT_RESPONSE_POLICY, normalizePolicy, policyValidationError } from "./MemberAiResponsePolicy";
import MemberAiPolicyTest from "./MemberAiPolicyTest";
import dougalAvatar from "@assets/ChatGPT_Image_Jul_4,_2026,_06_26_22_PM_1783182456658.png";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const RASTER_TYPES = ["image/png", "image/jpeg", "image/webp"];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_DESCRIPTION_LENGTH = 500;
const DEFAULT_DESCRIPTION = "Your AI guide to everything in the member portal.";
const validDescription = value => value.length <= MAX_DESCRIPTION_LENGTH && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const outlineButtonClass = "!border-slate-600 !bg-slate-800 !text-slate-100 hover:!border-slate-500 hover:!bg-slate-700 hover:!text-white disabled:!border-slate-700 disabled:!bg-slate-800 disabled:!text-slate-400";

function normalizeOverrides(value) {
  return {
    enabled: value?.enabled === true,
    name: typeof value?.name === "string" ? value.name : "",
    description: typeof value?.description === "string" ? value.description.trim() : "",
    avatarUrl: typeof value?.avatarUrl === "string" ? value.avatarUrl : "",
    backgroundColor: typeof value?.backgroundColor === "string" ? value.backgroundColor : "",
    textColor: typeof value?.textColor === "string" ? value.textColor : "",
    ...(value?.responsePolicy !== undefined ? { responsePolicy: normalizePolicy(value.responsePolicy) } : {}),
  };
}

async function readResponse(response, fallback) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || fallback);
  return data;
}

export default function MemberAiAssistantSettings({ tenantId }) {
  const queryClient = useQueryClient();
  const fileInput = useRef(null);
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError("");
    setDraft(null);
    adminFetch("/api/member-ai/config", { credentials: "include" })
      .then(response => readResponse(response, "Could not load assistant settings."))
      .then(data => {
        if (cancelled) return;
        // The effective fields include inherited values; only overrides belong in the editor.
        const overrides = normalizeOverrides({ ...data.overrides, enabled: data.enabled,
          ...(data.responsePolicy !== undefined ? { responsePolicy: data.responsePolicy } : {}) });
        setConfig(data);
        setDraft(overrides);
        setSaved(overrides);
      })
      .catch(err => { if (!cancelled) setLoadError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId, reloadKey]);

  const update = (key, value) => {
    setDraft(previous => ({ ...previous, [key]: value }));
    setSuccess("");
    setError("");
  };
  const updatePolicy = value => update("responsePolicy", value);

  const handleUpload = async (file) => {
    if (!file) return;
    setSuccess("");
    if (!RASTER_TYPES.includes(file.type)) {
      setError("Choose a PNG, JPEG or WebP image. SVG and animated images are not supported.");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES || file.size === 0) {
      setError("Choose an image smaller than 5 MB.");
      return;
    }
    setError("");
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const data = await readResponse(
        await adminFetch("/api/integrations/upload-file", { method: "POST", credentials: "include", body }),
        "Image upload failed."
      );
      if (!data.file_url) throw new Error("Upload finished without an image URL.");
      update("avatarUrl", data.file_url);
    } catch (err) {
      setError(err.message || "Image upload failed.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const save = async () => {
    if (!draft || saving || uploading) return;
    if (!validDescription(draft.description)) {
      setError("Use plain text up to 500 characters, without control characters.");
      return;
    }
    const payload = normalizeOverrides({
      ...draft,
      name: draft.name.trim(),
      backgroundColor: draft.backgroundColor.trim(),
      textColor: draft.textColor.trim(),
    });
    const policyError = policyValidationError(draft.responsePolicy ?? DEFAULT_RESPONSE_POLICY);
    if (policyError) {
      setError(policyError);
      return;
    }
    if ((payload.backgroundColor && !HEX_COLOR.test(payload.backgroundColor)) ||
        (payload.textColor && !HEX_COLOR.test(payload.textColor))) {
      setError("Enter a six-digit hex colour, such as #334155, or leave it empty to inherit.");
      return;
    }
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const result = await readResponse(
        await adminFetch("/api/admin/tenant", {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { member_ai_assistant: payload } }),
        }),
        "Could not save assistant settings."
      );
      // Prefer the canonical saved overrides over the submitted draft.
      const canonical = result.tenant?.settings?.member_ai_assistant
        ? normalizeOverrides(result.tenant.settings.member_ai_assistant)
        : payload;
      setDraft(canonical);
      setSaved(canonical);
      try {
        const refreshed = await readResponse(
          await adminFetch("/api/member-ai/config", { credentials: "include" }),
          "Could not refresh assistant preview."
        );
        const resolved = normalizeOverrides({ ...refreshed.overrides, enabled: refreshed.enabled,
          ...(refreshed.responsePolicy !== undefined ? { responsePolicy: refreshed.responsePolicy } : {}) });
        setConfig(refreshed);
        setDraft(resolved);
        setSaved(resolved);
      } catch {
        setConfig(previous => previous && ({
          ...previous,
          enabled: canonical.enabled,
          name: canonical.name || previous.name,
          description: canonical.description,
          avatarUrl: canonical.avatarUrl || previous.avatarUrl,
          backgroundColor: canonical.backgroundColor,
          textColor: canonical.textColor,
        }));
      }
      await queryClient.invalidateQueries({ queryKey: ["tenant-ai-assistant", tenantId] });
      setSuccess("Assistant settings saved.");
    } catch (err) {
      setError(err.message || "Could not save assistant settings.");
    } finally {
      setSaving(false);
    }
  };

  const effectiveName = draft?.name.trim() || (!saved?.name ? config?.name : "") || "Dougal";
  const effectiveAvatar = draft?.avatarUrl || (saved?.avatarUrl ? "" : config?.avatarUrl) || dougalAvatar;
  const effectiveColor = HEX_COLOR.test(draft?.backgroundColor || "")
    ? draft.backgroundColor
    : !draft?.backgroundColor && !saved?.backgroundColor && HEX_COLOR.test(config?.backgroundColor || "")
      ? config.backgroundColor : "";
  const colorValid = !draft?.backgroundColor || HEX_COLOR.test(draft.backgroundColor);
  const textColorValid = !draft?.textColor || HEX_COLOR.test(draft.textColor);
  const previewStyle = resolveMemberAiLauncherStyle({ backgroundColor: effectiveColor, textColor: draft?.textColor });
  const descriptionValid = !draft || validDescription(draft.description);
  const policyError = draft ? policyValidationError(draft.responsePolicy ?? DEFAULT_RESPONSE_POLICY) : "";
  const dirty = draft && saved && JSON.stringify(draft) !== JSON.stringify(saved);

  return (
    <Card className="bg-slate-800/50 border-slate-700" data-testid="card-member-ai-assistant">
      <CardHeader>
        <CardTitle className="text-white flex items-center gap-2"><Bot className="w-5 h-5 text-sky-400" /> AI Assistant</CardTitle>
        <CardDescription className="text-slate-400">
          Choose how the assistant appears in the member portal. Changes here are saved separately from other tenant settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading ? (
          <div className="space-y-3 animate-pulse" aria-label="Loading assistant settings">
            <div className="h-16 rounded-lg bg-slate-700/60" />
            <div className="h-10 w-2/3 rounded-lg bg-slate-700/60" />
            <div className="h-20 rounded-lg bg-slate-700/60" />
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-rose-700/50 bg-rose-950/30 p-4 text-sm text-rose-200" role="alert">
            <p>{loadError}</p>
            <Button type="button" variant="outline" size="sm" className={`mt-3 ${outlineButtonClass}`} onClick={() => setReloadKey(key => key + 1)}>Try again</Button>
          </div>
        ) : draft && (
          <>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-600 bg-slate-900/50 p-4">
              <div className="space-y-1">
                <Label htmlFor="ai-assistant-enabled" className="text-slate-200 font-medium">Show AI Assistant to members</Label>
                <p className="text-sm text-slate-400">Switching this off keeps your name, description, image and colour for later.</p>
              </div>
              <Switch id="ai-assistant-enabled" checked={draft.enabled} disabled={saving || uploading} onCheckedChange={value => update("enabled", value)} data-testid="switch-ai-assistant-enabled" />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-assistant-name" className="text-slate-200">Assistant name</Label>
              <Input id="ai-assistant-name" value={draft.name} onChange={event => update("name", event.target.value)} maxLength={80} disabled={saving || uploading}
                placeholder={!saved?.name ? (config?.name || "Dougal") : "Dougal"} className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500" data-testid="input-ai-assistant-name" />
              <p className="text-xs text-slate-400">Leave blank to use the default name.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-assistant-description" className="text-slate-200">Description</Label>
              <Textarea id="ai-assistant-description" value={draft.description}
                onChange={event => update("description", event.target.value)}
                maxLength={MAX_DESCRIPTION_LENGTH} rows={3} disabled={saving || uploading}
                placeholder={DEFAULT_DESCRIPTION} aria-invalid={!descriptionValid}
                aria-describedby="ai-assistant-description-help"
                className="bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500"
                data-testid="input-ai-assistant-description" />
              <p id="ai-assistant-description-help" className="text-xs text-slate-400">
                Introductory text in your member assistant modal. Plain text, up to 500 characters. Leave blank to use the neutral default shown below. This does not change the Help Center assistant.
              </p>
              {!descriptionValid && <p className="text-xs text-rose-300" role="alert">Use plain text up to 500 characters, without control characters.</p>}
            </div>

            <div className="space-y-3">
              <Label className="text-slate-200">Assistant image</Label>
              <div className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-600 bg-slate-900/50 p-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-700 text-slate-300">
                  <img src={effectiveAvatar} alt="Assistant avatar preview" className="h-full w-full object-cover" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
                    aria-label="Upload assistant image" onChange={event => handleUpload(event.target.files?.[0])} data-testid="input-ai-assistant-avatar" />
                  <Button type="button" variant="outline" size="sm" disabled={uploading || saving} onClick={() => fileInput.current?.click()} className={outlineButtonClass}>
                    {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ImagePlus className="mr-2 h-4 w-4" />}
                    {uploading ? "Uploading..." : "Upload image"}
                  </Button>
                  {draft.avatarUrl && <Button type="button" variant="outline" size="sm" disabled={uploading || saving} onClick={() => update("avatarUrl", "")} className={outlineButtonClass}><Trash2 className="mr-2 h-4 w-4" /> Remove</Button>}
                </div>
              </div>
              <p className="text-xs text-slate-400">PNG, JPEG or WebP, up to 5 MB. Removing an image restores the default.</p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ai-assistant-color" className="text-slate-200">Background colour</Label>
              <div className="flex flex-wrap items-center gap-2">
                <input type="color" value={effectiveColor || "#334155"} disabled={saving || uploading} onChange={event => update("backgroundColor", event.target.value.toUpperCase())}
                  aria-label="Pick assistant background colour" className="h-10 w-12 cursor-pointer rounded border border-slate-600 bg-slate-900 p-1" />
                <Input id="ai-assistant-color" value={draft.backgroundColor} disabled={saving || uploading} onChange={event => update("backgroundColor", event.target.value)}
                  placeholder={!saved?.backgroundColor ? (config?.backgroundColor || "#334155") : "#334155"} maxLength={7} aria-invalid={!colorValid}
                  className="w-40 bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500 font-mono" data-testid="input-ai-assistant-color" />
                <Button type="button" variant="outline" size="sm" disabled={!draft.backgroundColor || saving || uploading} onClick={() => update("backgroundColor", "")} className={outlineButtonClass}><RotateCcw className="mr-2 h-4 w-4" /> Use default</Button>
              </div>
              <p className="text-xs text-slate-400">Use a six-digit hex colour, or leave blank to inherit.</p>
              {!colorValid && <p className="text-xs text-rose-300" role="alert">Enter a colour in #RRGGBB format.</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-assistant-text-color" className="text-slate-200">Text colour</Label>
              <div className="flex flex-wrap items-center gap-2">
                <input type="color" value={previewStyle?.color || "#ffffff"} disabled={saving || uploading}
                  onChange={event => update("textColor", event.target.value.toUpperCase())}
                  aria-label="Pick assistant text colour" className="h-10 w-12 cursor-pointer rounded border border-slate-600 bg-slate-900 p-1" />
                <Input id="ai-assistant-text-color" value={draft.textColor} disabled={saving || uploading}
                  onChange={event => update("textColor", event.target.value)} placeholder="Automatic" maxLength={7}
                  aria-invalid={!textColorValid} className="w-40 bg-slate-900/50 border-slate-600 text-white placeholder:text-slate-500 font-mono"
                  data-testid="input-ai-assistant-text-color" />
                <Button type="button" variant="outline" size="sm" disabled={!draft.textColor || saving || uploading}
                  onClick={() => update("textColor", "")} className={outlineButtonClass}><RotateCcw className="mr-2 h-4 w-4" /> Automatic</Button>
              </div>
              <p className="text-xs text-slate-400">Use #RRGGBB, or Automatic to restore contrast/default text.</p>
              {!textColorValid && <p className="text-xs text-rose-300" role="alert">Enter a colour in #RRGGBB format.</p>}
            </div>
            </div>

            <div className="rounded-xl border border-slate-600 bg-slate-900/60 p-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-wider text-slate-400">Member preview {draft.enabled ? "" : "· hidden while disabled"}</p>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl text-white" style={{ backgroundColor: effectiveColor }}>
                  <img src={effectiveAvatar} alt="" className="h-full w-full object-cover" />
                </div>
                <span className="text-sm font-medium text-slate-200">{effectiveName}</span>
                <Button type="button" data-testid="ai-assistant-launcher-preview"
                  className={`ml-auto ${previewStyle?.["--ai-bg"] ? "bg-[var(--ai-bg)] hover:bg-[var(--ai-hover)] focus-visible:bg-[var(--ai-hover)]" : ""}`}
                  style={previewStyle}>Ask {effectiveName}</Button>
              </div>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-300" data-testid="text-ai-assistant-description-preview">{draft.description.trim() || DEFAULT_DESCRIPTION}</p>
            </div>

            <MemberAiResponsePolicy value={draft.responsePolicy ?? DEFAULT_RESPONSE_POLICY} onChange={updatePolicy} disabled={saving || uploading} />
            {policyError && <p className="text-sm text-rose-300" role="alert">{policyError}</p>}

            {error && <p className="text-sm text-rose-300" role="alert">{error}</p>}
            {success && <p className="flex items-center gap-2 text-sm text-emerald-300" role="status"><CheckCircle2 className="h-4 w-4" /> {success}</p>}
            <div className="flex items-center justify-end gap-3">
              {dirty && <span className="text-xs text-slate-400">Unsaved changes</span>}
              <Button type="button" onClick={save} disabled={!dirty || !colorValid || !textColorValid || !descriptionValid || !!policyError || saving || uploading} data-testid="button-save-ai-assistant">
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                {saving ? "Saving..." : "Save AI Assistant"}
              </Button>
            </div>
            <MemberAiPolicyTest key={tenantId} tenantId={tenantId} enabled={saved?.enabled === true} hasUnsavedChanges={!!dirty} saving={saving || uploading} />
          </>
        )}
      </CardContent>
    </Card>
  );
}