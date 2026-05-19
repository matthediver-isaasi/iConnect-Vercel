import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw, Image as ImageIcon } from "lucide-react";

function hostnameOf(url) {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n - 1).trimEnd()}…` : str;
}

function SlackCard({ title, description, image, url, siteName }) {
  const host = hostnameOf(url);
  return (
    <div className="bg-white rounded-md p-3 border-l-4 border-l-slate-300 max-w-xl">
      <p className="text-xs text-slate-500 mb-2 truncate">{siteName || host || "your-site"}</p>
      <div className="flex gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-blue-700 hover:underline truncate" data-testid="text-unfurl-slack-title">
            {title || "Page title"}
          </p>
          <p className="text-xs text-slate-700 mt-1 line-clamp-3" data-testid="text-unfurl-slack-description">
            {description || "Page description shown in the link preview."}
          </p>
        </div>
        {image ? (
          <img
            src={image}
            alt=""
            className="w-20 h-20 object-cover rounded flex-shrink-0 border border-slate-200"
            data-testid="img-unfurl-slack"
          />
        ) : null}
      </div>
    </div>
  );
}

function IMessageCard({ title, description, image, url }) {
  const host = hostnameOf(url);
  return (
    <div className="rounded-2xl overflow-hidden bg-slate-100 border border-slate-200 max-w-xs">
      {image ? (
        <img
          src={image}
          alt=""
          className="w-full h-40 object-cover bg-white"
          data-testid="img-unfurl-imessage"
        />
      ) : (
        <div className="w-full h-40 flex items-center justify-center bg-slate-200 text-slate-400">
          <ImageIcon className="w-8 h-8" />
        </div>
      )}
      <div className="px-3 py-2 bg-slate-200/70">
        <p className="text-[13px] font-medium text-slate-900 line-clamp-2" data-testid="text-unfurl-imessage-title">
          {truncate(title || "Page title", 80)}
        </p>
        {description ? (
          <p className="text-[11px] text-slate-600 line-clamp-1 mt-0.5">{description}</p>
        ) : null}
        <p className="text-[11px] text-slate-500 mt-0.5 truncate">{host || "your-site"}</p>
      </div>
    </div>
  );
}

function XCard({ title, description, image, url }) {
  const host = hostnameOf(url);
  return (
    <div className="rounded-2xl overflow-hidden bg-black border border-slate-700 max-w-xl">
      {image ? (
        <img
          src={image}
          alt=""
          className="w-full h-56 object-cover"
          data-testid="img-unfurl-x"
        />
      ) : (
        <div className="w-full h-56 flex items-center justify-center bg-slate-900 text-slate-600">
          <ImageIcon className="w-10 h-10" />
        </div>
      )}
      <div className="px-3 py-2 border-t border-slate-700">
        <p className="text-xs text-slate-400 truncate">{host || "your-site"}</p>
        <p className="text-sm font-normal text-white line-clamp-2" data-testid="text-unfurl-x-title">
          {truncate(title || "Page title", 70)}
        </p>
        {description ? (
          <p className="text-xs text-slate-400 line-clamp-2 mt-0.5">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Reusable link-preview ("unfurl") component that renders cards in the
 * visual style of Slack, iMessage, and X/Twitter.
 *
 * Props:
 *  - title, description, image, url, siteName: live preview values from the
 *    settings form (used immediately, no save required).
 *  - previewPath: optional path (e.g. "/about") used for the "Live (server)"
 *    mode that fetches the actual SSR'd <head> from /api/unfurl-preview.
 *  - className: optional wrapper class.
 */
export default function UnfurlPreview({
  title,
  description,
  image,
  url,
  siteName,
  previewPath,
  className = "",
}) {
  const [mode, setMode] = useState("draft"); // 'draft' | 'live'
  const [serverData, setServerData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchLive = async () => {
    if (!previewPath) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/unfurl-preview?path=${encodeURIComponent(previewPath)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setServerData(data);
    } catch (err) {
      setError("Could not load the live SSR preview.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (mode !== "live") return;
    setServerData(null);
    fetchLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, previewPath]);

  const draftValues = {
    title: title || "",
    description: description || "",
    image: image || "",
    url: url || "",
    siteName: siteName || "",
  };

  const values = mode === "live" && serverData ? {
    title: serverData.title || "",
    description: serverData.description || "",
    image: serverData.image || "",
    url: serverData.url || draftValues.url,
    siteName: serverData.siteName || draftValues.siteName,
  } : draftValues;

  return (
    <div className={`rounded-md border border-slate-200 bg-white p-3 space-y-3 ${className}`} data-testid="unfurl-preview">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs uppercase tracking-wide text-slate-500">Link preview</p>
        {previewPath ? (
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-xs">
              <button
                type="button"
                onClick={() => setMode("draft")}
                className={`px-2 py-1 ${mode === "draft" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover-elevate"}`}
                data-testid="button-unfurl-mode-draft"
              >
                Draft
              </button>
              <button
                type="button"
                onClick={() => setMode("live")}
                className={`px-2 py-1 border-l border-slate-200 ${mode === "live" ? "bg-slate-900 text-white" : "bg-white text-slate-700 hover-elevate"}`}
                data-testid="button-unfurl-mode-live"
              >
                Live (server)
              </button>
            </div>
            {mode === "live" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={fetchLive}
                disabled={loading}
                data-testid="button-unfurl-refresh"
              >
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {mode === "live" && loading ? (
        <div className="flex items-center justify-center py-10 text-slate-500 text-sm">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Fetching live SSR preview…
        </div>
      ) : (
        <Tabs defaultValue="slack" className="w-full">
          <TabsList>
            <TabsTrigger value="slack" data-testid="tab-unfurl-slack">Slack</TabsTrigger>
            <TabsTrigger value="imessage" data-testid="tab-unfurl-imessage">iMessage</TabsTrigger>
            <TabsTrigger value="x" data-testid="tab-unfurl-x">X</TabsTrigger>
          </TabsList>
          <TabsContent value="slack" className="pt-3">
            <SlackCard {...values} />
          </TabsContent>
          <TabsContent value="imessage" className="pt-3">
            <IMessageCard {...values} />
          </TabsContent>
          <TabsContent value="x" className="pt-3">
            <XCard {...values} />
          </TabsContent>
        </Tabs>
      )}

      {error ? (
        <p className="text-xs text-amber-700" data-testid="text-unfurl-error">{error}</p>
      ) : null}
      {mode === "live" && !error ? (
        <p className="text-[11px] text-slate-500">
          Shows the meta tags returned by the SSR pipeline that real unfurl bots see. Save and republish to refresh.
        </p>
      ) : null}
    </div>
  );
}
