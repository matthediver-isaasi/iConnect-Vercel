import { useCallback, useEffect, useMemo, useState } from "react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link2, Loader2, Check, ExternalLink } from "lucide-react";

const EXTERNAL = "__external__";
const INTERNAL_NONE = "__none__";

function rowKey(pageId, row) {
  const cp = (row.path?.contentPath || []).join(".");
  const anchor = Number.isInteger(row.path?.anchorIndex) ? `#${row.path.anchorIndex}` : "";
  return `${pageId}:${row.blockId}:${cp}${anchor}`;
}

function SetLinkControl({ internalPages, currentValue, saving, saved, onSave }) {
  // Determine the initial mode from the current value: an internal target is a
  // value that matches "/Slug" of a known canvas page; anything else with a
  // value is treated as external.
  const matchInternal = useMemo(() => {
    if (!currentValue) return null;
    const v = String(currentValue);
    const hit = internalPages.find((p) => `/${p.slug}` === v || p.slug === v);
    return hit ? hit.slug : null;
  }, [currentValue, internalPages]);

  const [mode, setMode] = useState(() => (matchInternal ? "internal" : currentValue ? "external" : "internal"));
  const [internalSlug, setInternalSlug] = useState(matchInternal || INTERNAL_NONE);
  const [externalUrl, setExternalUrl] = useState(matchInternal ? "" : (currentValue || ""));

  const handleSave = () => {
    let next = "";
    if (mode === "internal") {
      next = internalSlug && internalSlug !== INTERNAL_NONE ? `/${internalSlug}` : "";
    } else {
      next = (externalUrl || "").trim();
    }
    onSave(next);
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Select
        value={mode === "internal" ? "internal" : EXTERNAL}
        onValueChange={(v) => setMode(v === EXTERNAL ? "external" : "internal")}
      >
        <SelectTrigger className="w-full sm:w-[130px]" data-testid="select-link-mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="internal">Internal page</SelectItem>
          <SelectItem value={EXTERNAL}>External URL</SelectItem>
        </SelectContent>
      </Select>

      {mode === "internal" ? (
        <Select value={internalSlug} onValueChange={setInternalSlug}>
          <SelectTrigger className="w-full sm:w-[220px]" data-testid="select-internal-page">
            <SelectValue placeholder="Choose a page" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INTERNAL_NONE}>— None (clear) —</SelectItem>
            {internalPages.map((p) => (
              <SelectItem key={p.id} value={p.slug}>
                {p.title || p.slug}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          value={externalUrl}
          onChange={(e) => setExternalUrl(e.target.value)}
          placeholder="https://example.com"
          className="w-full sm:w-[220px]"
          data-testid="input-external-url"
        />
      )}

      <Button
        size="sm"
        onClick={handleSave}
        disabled={saving}
        data-testid="button-save-link"
      >
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : saved ? (
          <Check className="h-4 w-4" />
        ) : (
          "Save"
        )}
      </Button>
    </div>
  );
}

export default function CanvasLinksManager() {
  const { toast } = useToast();
  const { isFeatureExcluded, isAccessReady } = useMemberAccess();
  const [accessChecked, setAccessChecked] = useState(false);

  const [pages, setPages] = useState([]);
  const [internalPages, setInternalPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hidePopulated, setHidePopulated] = useState(false);
  const [savingKey, setSavingKey] = useState(null);
  const [savedKey, setSavedKey] = useState(null);

  useEffect(() => {
    if (isAccessReady) {
      if (isFeatureExcluded("page_admin_CanvasLinksManager")) {
        window.location.href = createPageUrl("Dashboard");
      } else {
        setAccessChecked(true);
      }
    }
  }, [isFeatureExcluded, isAccessReady]);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest("GET", "/api/admin/canvas-links");
      setPages(res.pages || []);
      setInternalPages(res.internalPages || []);
    } catch (err) {
      toast({
        title: "Failed to load canvas links",
        description: err.message,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (accessChecked) loadLinks();
  }, [accessChecked, loadLinks]);

  const handleSave = useCallback(
    async (page, row, newValue) => {
      const key = rowKey(page.id, row);
      setSavingKey(key);
      try {
        const res = await apiRequest("PUT", "/api/admin/canvas-links", {
          pageId: page.id,
          blockId: row.blockId,
          path: row.path,
          value: newValue,
        });
        // Replace this page's links with the freshly extracted set.
        setPages((prev) =>
          prev.map((p) => (p.id === page.id ? { ...p, links: res.links || p.links } : p))
        );
        setSavedKey(key);
        setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 2000);
        toast({ title: "Link updated" });
      } catch (err) {
        toast({
          title: "Failed to update link",
          description: err.message,
          variant: "destructive",
        });
      } finally {
        setSavingKey((k) => (k === key ? null : k));
      }
    },
    [toast]
  );

  const visiblePages = useMemo(() => {
    return pages
      .map((p) => {
        const links = hidePopulated ? p.links.filter((l) => !l.value) : p.links;
        return { ...p, visibleLinks: links };
      })
      .filter((p) => p.visibleLinks.length > 0 || !hidePopulated);
  }, [pages, hidePopulated]);

  const totalLinks = useMemo(
    () => pages.reduce((acc, p) => acc + (p.links?.length || 0), 0),
    [pages]
  );
  const emptyLinks = useMemo(
    () => pages.reduce((acc, p) => acc + (p.links?.filter((l) => !l.value).length || 0), 0),
    [pages]
  );

  if (!accessChecked) {
    return (
      <div className="flex items-center justify-center p-12" data-testid="status-access-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-page-title">
              Canvas Links Manager
            </h1>
            <p className="text-sm text-muted-foreground">
              Review and set every link across your CanvasBuilder pages in one place.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="hide-populated"
            checked={hidePopulated}
            onCheckedChange={setHidePopulated}
            data-testid="switch-hide-populated"
          />
          <Label htmlFor="hide-populated" className="text-sm">
            Hide populated links
          </Label>
        </div>
      </div>

      {!loading && (
        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground" data-testid="text-summary">
          <Badge variant="secondary">{pages.length} pages</Badge>
          <Badge variant="secondary">{totalLinks} links</Badge>
          <Badge variant="secondary">{emptyLinks} empty</Badge>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center p-12" data-testid="status-loading">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : visiblePages.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground" data-testid="text-empty">
            No CanvasBuilder pages with links found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {visiblePages.map((page) => (
            <Card key={page.id} data-testid={`card-page-${page.id}`}>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">
                  {page.title || page.slug}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">/{page.slug}</span>
                </CardTitle>
                <Badge variant={page.status === "published" ? "default" : "secondary"}>
                  {page.status || "draft"}
                </Badge>
              </CardHeader>
              <CardContent>
                {page.visibleLinks.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid={`text-no-links-${page.id}`}>
                    No matching links.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[220px]">Link type</TableHead>
                        <TableHead>Current link</TableHead>
                        <TableHead className="w-[380px]">Set link</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {page.visibleLinks.map((row) => {
                        const key = rowKey(page.id, row);
                        return (
                          <TableRow key={key} data-testid={`row-link-${key}`}>
                            <TableCell className="align-top">
                              <div className="font-medium">{row.label}</div>
                              {row.context && (
                                <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                                  {row.context}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              {row.value ? (
                                <span className="inline-flex items-center gap-1 break-all text-sm" data-testid={`text-current-${key}`}>
                                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  {row.value}
                                </span>
                              ) : (
                                <Badge variant="outline" data-testid={`badge-empty-${key}`}>
                                  Empty
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              <SetLinkControl
                                internalPages={internalPages}
                                currentValue={row.value}
                                saving={savingKey === key}
                                saved={savedKey === key}
                                onSave={(v) => handleSave(page, row, v)}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
