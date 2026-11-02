import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

const FIELDS = [
  { key: "meta_title", label: "Meta Title" },
  { key: "meta_description", label: "Meta Description", multiline: true },
  { key: "seo_title", label: "Social Title" },
  { key: "seo_description", label: "Social Description", multiline: true },
  { key: "og_image_url", label: "Social Image URL" },
];

function SocialImagePreview({ url }) {
  const [status, setStatus] = useState("loading");
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) return null;
  } catch { return null; }
  return (
    <div className="rounded-md border bg-slate-50 p-3 space-y-2">
      <p className="text-xs font-medium text-slate-600">Social image preview</p>
      {status === "loading" && (
        <p role="status" className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading image…
        </p>
      )}
      {status === "error" ? (
        <p role="status" className="text-sm text-slate-600">This image could not be loaded. Check the URL or choose another image.</p>
      ) : (
        <img src={url} alt="Suggested social sharing image" referrerPolicy="no-referrer"
          className="w-full max-h-56 object-contain rounded"
          onLoad={() => setStatus("loaded")} onError={() => setStatus("error")} />
      )}
    </div>
  );
}

// Mounted only while open: unapplied drafts never escape this dialog.
export default function PageSeoSuggestionsDialog({ context, values, onApply, onClose }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState(null);
  const [applied, setApplied] = useState({});
  const [imageError, setImageError] = useState("");
  const [missingImage, setMissingImage] = useState(false);
  const requestRef = useRef(null);
  const latest = useRef({ context, values });
  latest.current = { context, values };

  const loadSuggestions = async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setDrafts(null);
    setApplied({});
    setImageError("");
    try {
      const { context: currentContext, values: currentValues } = latest.current;
      const response = await fetch("/api/ai-compositions/seo", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          pageId: currentContext.pageId,
          design: currentContext.getDesign(),
          title: currentValues.title || "",
          slug: currentValues.slug || "",
          values: Object.fromEntries(FIELDS.map(({ key }) => [key, currentValues[key] || ""])),
        }),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || "Could not generate suggestions. Please try again.");
      }
      const body = await response.json();
      if (!body?.suggestions || typeof body.suggestions !== "object" || Array.isArray(body.suggestions)) {
        throw new Error("The suggestions could not be read. Please try again.");
      }
      if (controller.signal.aborted || requestRef.current !== controller) return;
      const next = Object.fromEntries(FIELDS.map(({ key }) => [
        key, typeof body.suggestions[key] === "string" ? body.suggestions[key] : "",
      ]));
      setDrafts(next);
      setMissingImage(!next.og_image_url.trim());
    } catch (err) {
      if (!controller.signal.aborted && requestRef.current === controller) {
        setError(err?.message || "Could not generate suggestions. Please try again.");
      }
    } finally {
      if (!controller.signal.aborted && requestRef.current === controller) setLoading(false);
    }
  };

  const loadRef = useRef(loadSuggestions);
  loadRef.current = loadSuggestions;
  useEffect(() => {
    loadRef.current();
    return () => requestRef.current?.abort();
  }, []);

  const close = () => {
    requestRef.current?.abort();
    onClose();
  };

  const applyField = (key) => {
    let value = drafts[key];
    if (key === "og_image_url") {
      value = value.trim();
      if (value) {
        try {
          const url = new URL(value);
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Invalid protocol");
        } catch {
          setImageError("Enter a full http:// or https:// image URL, or leave this field empty.");
          return;
        }
      }
      setImageError("");
    }
    onApply({ [key]: value });
    setApplied((prev) => ({ ...prev, [key]: true }));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>AI SEO &amp; social suggestions</DialogTitle>
          <DialogDescription>
            Review and edit each suggestion, then Apply the fields you want. You must Save page
            settings to persist applied changes. Closing discards unapplied suggestions.
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <div className="flex items-center justify-center gap-3 py-10 text-sm text-slate-500" role="status">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            Generating suggestions…
          </div>
        )}
        {error && (
          <div className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4">
            <p role="alert" className="text-sm text-red-700">{error}</p>
            <Button type="button" variant="outline" size="sm" onClick={loadSuggestions}>Retry</Button>
          </div>
        )}
        {drafts && !loading && (
          <div className="space-y-5">
            {FIELDS.map(({ key, label, multiline }) => {
              const Field = multiline ? Textarea : Input;
              const id = `ai-seo-${key}`;
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={id}>{label}</Label>
                  <Field
                    id={id}
                    value={drafts[key]}
                    {...(multiline ? { rows: 3 } : { type: "text" })}
                    aria-invalid={key === "og_image_url" && !!imageError}
                    aria-describedby={key === "og_image_url" ? `${id}-hint${imageError ? ` ${id}-error` : ""}` : undefined}
                    onChange={(e) => {
                      setDrafts((prev) => ({ ...prev, [key]: e.target.value }));
                      setApplied((prev) => ({ ...prev, [key]: false }));
                      if (key === "og_image_url") setImageError("");
                    }}
                  />
                  {key === "og_image_url" && (
                    <>
                      <p id={`${id}-hint`} className="text-xs text-slate-500">
                        {missingImage
                          ? "No suitable image found in this design. You can enter an image URL manually."
                          : "Use a full http:// or https:// image URL. You can edit or clear it before applying."}
                      </p>
                      {imageError && <p id={`${id}-error`} role="alert" className="text-xs text-red-700">{imageError}</p>}
                      <SocialImagePreview key={drafts[key].trim()} url={drafts[key].trim()} />
                    </>
                  )}
                  <div className="flex items-center gap-3">
                    <Button type="button" variant="outline" size="sm" onClick={() => applyField(key)} aria-label={`Apply ${label}`}>
                      Apply
                    </Button>
                    <span role="status" className="text-xs text-slate-500">
                      {applied[key] ? "Applied to page settings — not saved" : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
