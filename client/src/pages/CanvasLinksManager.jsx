import { useCallback, useEffect, useMemo, useState } from "react";
import { useMemberAccess } from "@/hooks/useMemberAccess";
import { createPageUrl } from "@/utils";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";
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
import { Link2, Loader2, ExternalLink, Save, Undo2 } from "lucide-react";

const EXTERNAL = "__external__";
const INTERNAL_NONE = "__none__";

function rowKey(pageId, row) {
  const cp = (row.path?.contentPath || []).join(".");
  const anchor = Number.isInteger(row.path?.anchorIndex) ? `#${row.path.anchorIndex}` : "";
  return `${pageId}:${row.blockId}:${cp}${anchor}`;
}

function SetLinkControl({ internalPages, originalValue, stagedValue, onChange }) {
  // The value the control should reflect: the staged (pending) value when one
  // exists, otherwise the currently saved value.
  const effectiveValue = stagedValue !== undefined ? stagedValue : originalValue || "";

  // Determine the initial mode from the effective value: an internal target is
  // a value that matches "/Slug" of a known canvas page; anything else with a
  // value is treated as external.
  const matchInternal = useMemo(() => {
    if (!effectiveValue) return null;
    const v = String(effectiveValue);
    const hit = internalPages.find((p) => `/${p.slug}` === v || p.slug === v);
    return hit ? hit.slug : null;
  }, [effectiveValue, internalPages]);

  const [mode, setMode] = useState(() => (matchInternal ? "internal" : effectiveValue ? "external" : "internal"));
  const [internalSlug, setInternalSlug] = useState(matchInternal || INTERNAL_NONE);
  const [externalUrl, setExternalUrl] = useState(matchInternal ? "" : effectiveValue);

  // Compute the next value for the given control state and stage it.
  const emit = (nextMode, nextSlug, nextUrl) => {
    let next = "";
    if (nextMode === "internal") {
      next = nextSlug && nextSlug !== INTERNAL_NONE ? `/${nextSlug}` : "";
    } else {
      next = (nextUrl || "").trim();
    }
    onChange(next);
  };

  const handleModeChange = (v) => {
    const nextMode = v === EXTERNAL ? "external" : "internal";
    setMode(nextMode);
    emit(nextMode, internalSlug, externalUrl);
  };

  const handleSlugChange = (v) => {
    setInternalSlug(v);
    emit(mode, v, externalUrl);
  };

  const handleUrlChange = (e) => {
    const v = e.target.value;
    setExternalUrl(v);
    emit(mode, internalSlug, v);
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Select
        value={mode === "internal" ? "internal" : EXTERNAL}
        onValueChange={handleModeChange}
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
        <Select value={internalSlug} onValueChange={handleSlugChange}>
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
          onChange={handleUrlChange}
          placeholder="https://example.com"
          className="w-full sm:w-[220px]"
          data-testid="input-external-url"
        />
      )}
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
  // Staged (not-yet-saved) changes keyed by rowKey ->
  //   { pageId, blockId, path, value }. A row whose staged value equals its
  //   saved value is removed from this map so it stops counting as dirty.
  const [staged, setStaged] = useState({});
  // Set of pageIds currently being saved (per-page or via Save all).
  const [savingPages, setSavingPages] = useState(() => new Set());
  // Bumped after a save/discard to remount the link controls so they re-derive
  // their internal state from the freshly saved (or reverted) values.
  const [resetVersion, setResetVersion] = useState(0);

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

  // Stage (or unstage) a single row's change. Staging never touches the server.
  const stageChange = useCallback((page, row, nextValue) => {
    const key = rowKey(page.id, row);
    const original = row.value || "";
    const value = nextValue || "";
    setStaged((prev) => {
      const copy = { ...prev };
      if (value === original) {
        // Reverted back to the saved value -> no longer dirty.
        delete copy[key];
      } else {
        copy[key] = {
          pageId: page.id,
          blockId: row.blockId,
          path: row.path,
          value,
        };
      }
      return copy;
    });
  }, []);

  // Group the current staged changes by pageId.
  const groupStagedByPage = useCallback(
    (keys) => {
      const byPage = new Map();
      for (const key of keys) {
        const change = staged[key];
        if (!change) continue;
        if (!byPage.has(change.pageId)) byPage.set(change.pageId, []);
        byPage.get(change.pageId).push({ key, ...change });
      }
      return byPage;
    },
    [staged]
  );

  // Commit the staged changes for the given pageIds. Each page is saved as one
  // transactional batch PUT; a failure on one page keeps the others' results
  // and leaves the failed page's changes staged so they can be retried.
  const commitPages = useCallback(
    async (pageIds) => {
      const keys = Object.keys(staged);
      const byPage = groupStagedByPage(keys);
      const targets = pageIds.filter((id) => byPage.has(id));
      if (targets.length === 0) return;

      setSavingPages((prev) => {
        const next = new Set(prev);
        targets.forEach((id) => next.add(id));
        return next;
      });

      const results = await Promise.allSettled(
        targets.map(async (pageId) => {
          const changes = byPage.get(pageId);
          const res = await apiRequest("PUT", "/api/admin/canvas-links", {
            pageId,
            updates: changes.map((c) => ({
              blockId: c.blockId,
              path: c.path,
              value: c.value,
            })),
          });
          return { pageId, changes, res };
        })
      );

      const succeededPageIds = [];
      const savedKeys = [];
      const pageLinksById = {};
      let failCount = 0;

      results.forEach((r) => {
        if (r.status === "fulfilled") {
          const { pageId, changes, res } = r.value;
          succeededPageIds.push(pageId);
          changes.forEach((c) => savedKeys.push(c.key));
          if (res?.links) pageLinksById[pageId] = res.links;
        } else {
          failCount += 1;
        }
      });

      // Refresh saved pages' links.
      if (succeededPageIds.length) {
        setPages((prev) =>
          prev.map((p) =>
            pageLinksById[p.id] ? { ...p, links: pageLinksById[p.id] } : p
          )
        );
        // Clear the staged entries that were successfully saved.
        setStaged((prev) => {
          const copy = { ...prev };
          savedKeys.forEach((k) => delete copy[k]);
          return copy;
        });
      }

      setSavingPages((prev) => {
        const next = new Set(prev);
        targets.forEach((id) => next.delete(id));
        return next;
      });
      // Remount controls so saved rows reflect their new values.
      setResetVersion((v) => v + 1);

      const savedChangeCount = savedKeys.length;
      if (failCount === 0) {
        toast({
          title:
            savedChangeCount === 1
              ? "1 link saved"
              : `${savedChangeCount} links saved`,
        });
      } else if (savedChangeCount > 0) {
        toast({
          title: "Some pages failed to save",
          description: `Saved ${savedChangeCount} change(s); ${failCount} page(s) failed. Their changes are still pending.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Failed to save links",
          description: `${failCount} page(s) failed. Your changes are still pending.`,
          variant: "destructive",
        });
      }
    },
    [staged, groupStagedByPage, toast]
  );

  const handleSaveAll = useCallback(() => {
    const pageIds = Array.from(
      new Set(Object.values(staged).map((c) => c.pageId))
    );
    return commitPages(pageIds);
  }, [staged, commitPages]);

  const handleDiscardAll = useCallback(() => {
    setStaged({});
    setResetVersion((v) => v + 1);
  }, []);

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
  // Links still needing a real destination: no value at all, or just the
  // placeholder "#" (which reads as populated to the "empty" count above).
  const unconfiguredLinks = useMemo(
    () =>
      pages.reduce(
        (acc, p) =>
          acc +
          (p.links?.filter((l) => {
            const v = typeof l.value === "string" ? l.value.trim() : "";
            return !v || v === "#";
          }).length || 0),
        0
      ),
    [pages]
  );

  // Total number of pending (staged) changes and a per-page breakdown.
  const stagedCount = useMemo(() => Object.keys(staged).length, [staged]);
  const stagedByPage = useMemo(() => {
    const counts = {};
    for (const change of Object.values(staged)) {
      counts[change.pageId] = (counts[change.pageId] || 0) + 1;
    }
    return counts;
  }, [staged]);
  const anySaving = savingPages.size > 0;

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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2 text-sm text-muted-foreground" data-testid="text-summary">
            <Badge variant="secondary">{pages.length} pages</Badge>
            <Badge variant="secondary">{totalLinks} links</Badge>
            <Badge variant="secondary">{emptyLinks} empty</Badge>
            <Badge
              variant={unconfiguredLinks > 0 ? "warning" : "secondary"}
              data-testid="badge-unconfigured-total"
            >
              {unconfiguredLinks} unconfigured
            </Badge>
            {stagedCount > 0 && (
              <Badge variant="warning" data-testid="badge-pending-total">
                {stagedCount} pending
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDiscardAll}
              disabled={stagedCount === 0 || anySaving}
              data-testid="button-discard-all"
            >
              <Undo2 className="h-4 w-4" />
              Discard
            </Button>
            <Button
              size="sm"
              onClick={handleSaveAll}
              disabled={stagedCount === 0 || anySaving}
              data-testid="button-save-all"
            >
              {anySaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {stagedCount > 0 ? `Save all (${stagedCount})` : "Save all"}
            </Button>
          </div>
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
          {visiblePages.map((page) => {
            const pagePending = stagedByPage[page.id] || 0;
            const pageSaving = savingPages.has(page.id);
            return (
            <Card key={page.id} data-testid={`card-page-${page.id}`}>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">
                  {page.title || page.slug}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">/{page.slug}</span>
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {pagePending > 0 && (
                    <>
                      <Badge variant="warning" data-testid={`badge-pending-${page.id}`}>
                        {pagePending} pending
                      </Badge>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => commitPages([page.id])}
                        disabled={pageSaving || anySaving}
                        data-testid={`button-save-page-${page.id}`}
                      >
                        {pageSaving ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4" />
                        )}
                        Save page
                      </Button>
                    </>
                  )}
                  <Badge variant={page.status === "published" ? "default" : "secondary"}>
                    {page.status || "draft"}
                  </Badge>
                </div>
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
                        <TableHead className="w-[180px]">Link type</TableHead>
                        <TableHead className="w-[140px]">Preview</TableHead>
                        <TableHead>Current link</TableHead>
                        <TableHead className="w-[380px]">Set link</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {page.visibleLinks.map((row) => {
                        const key = rowKey(page.id, row);
                        const stagedChange = staged[key];
                        const isPending = stagedChange !== undefined;
                        return (
                          <TableRow key={key} data-testid={`row-link-${key}`}>
                            <TableCell className="align-top">
                              <div className="min-w-0">
                                <div className="font-medium">{row.label}</div>
                                {row.context && (
                                  <div className="text-xs text-muted-foreground truncate max-w-[160px]">
                                    {row.context}
                                  </div>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="align-top">
                              {row.imageSrc ? (
                                <img
                                  src={row.imageSrc}
                                  alt={row.imageAlt || ""}
                                  className="h-10 w-10 shrink-0 rounded-md object-cover border"
                                  data-testid={`img-thumb-${key}`}
                                  onError={(e) => { e.currentTarget.style.display = "none"; }}
                                />
                              ) : row.buttonLabel ? (
                                <Badge variant="secondary" className="max-w-[130px] truncate" data-testid={`badge-cta-label-${key}`}>
                                  {row.buttonLabel}
                                </Badge>
                              ) : null}
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
                              {isPending && (
                                <div className="mt-1 text-xs text-warning break-all" data-testid={`text-pending-${key}`}>
                                  → {stagedChange.value || "(cleared)"}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="align-top">
                              <SetLinkControl
                                key={`${key}:${resetVersion}`}
                                internalPages={internalPages}
                                originalValue={row.value}
                                stagedValue={stagedChange ? stagedChange.value : undefined}
                                onChange={(v) => stageChange(page, row, v)}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
