import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, RotateCcw } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";
import {
  defaultDashboardWidgetPalette,
  paletteForEditing,
} from "@shared/dashboardWidgetPalette.js";

/**
 * Admin-only checklist of each data source's fields. Unticked fields are
 * hidden per-tenant from the widget builder's option lists (enforced
 * server-side in the sources catalog). Widgets already configured with a
 * hidden field keep working — hiding only trims the option list.
 */
export default function GroupingFieldSettingsModal({ open, onClose }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState("fields");
  // Local draft of the hidden map: { [sourceId]: Set(fieldKey) }.
  const [hiddenDraft, setHiddenDraft] = useState(null);
  const [paletteDraft, setPaletteDraft] = useState(null);

  const settingsQuery = useQuery({
    queryKey: ["/api/dashboard/hidden-fields"],
    enabled: open,
    queryFn: async () => {
      const res = await fetch("/api/dashboard/hidden-fields", { credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
      return body;
    },
  });

  // Seed the draft each time fresh data arrives while open.
  useEffect(() => {
    if (!open) {
      setHiddenDraft(null);
      setPaletteDraft(null);
      setActiveTab("fields");
      return;
    }
    if (settingsQuery.data && hiddenDraft === null) {
      const seed = {};
      for (const [sourceId, keys] of Object.entries(settingsQuery.data.hidden || {})) {
        seed[sourceId] = new Set(keys);
      }
      setHiddenDraft(seed);
      setPaletteDraft(paletteForEditing(settingsQuery.data.palette));
    }
  }, [open, settingsQuery.data, hiddenDraft]);

  const saveMutation = useMutation({
    mutationFn: async payload =>
      apiRequest("PUT", "/api/dashboard/hidden-fields", payload),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["/api/dashboard/hidden-fields"] });
      if (variables.hidden) {
        // The builder's catalog reflects the change on next fetch.
        qc.invalidateQueries({ queryKey: ["/api/dashboard/sources"] });
        toast({ title: "Grouping fields updated" });
      } else {
        qc.invalidateQueries({ queryKey: ["/api/dashboard/widgets"] });
        toast({ title: "Widget colour palette updated" });
      }
      onClose();
    },
    onError: err => {
      toast({
        title: "Save failed",
        description: err?.message || "Unable to save settings",
        variant: "destructive",
      });
    },
  });

  const toggleField = (sourceId, key, visible) => {
    setHiddenDraft(prev => {
      const next = { ...(prev || {}) };
      const set = new Set(next[sourceId] || []);
      if (visible) set.delete(key);
      else set.add(key);
      next[sourceId] = set;
      return next;
    });
  };

  const handleSave = () => {
    const payload = {};
    for (const [sourceId, set] of Object.entries(hiddenDraft || {})) {
      if (set.size > 0) payload[sourceId] = Array.from(set);
    }
    saveMutation.mutate({ hidden: payload });
  };

  const updatePaletteSlot = (key, patch) => {
    setPaletteDraft(current =>
      (current || []).map(slot => (slot.key === key ? { ...slot, ...patch } : slot)),
    );
  };

  const resetPalette = () => {
    setPaletteDraft(paletteForEditing(defaultDashboardWidgetPalette()));
  };

  const paletteErrors = (paletteDraft || []).flatMap(slot => {
    const errors = [];
    if (!slot.label.trim()) errors.push(`${slot.key}-label`);
    if (!/^#[0-9a-f]{6}$/i.test(slot.color)) errors.push(`${slot.key}-color`);
    return errors;
  });

  const handleSavePalette = () => {
    if (paletteErrors.length === 0) {
      const defaults = defaultDashboardWidgetPalette();
      saveMutation.mutate({
        palette: paletteDraft.map(slot => ({
          key: slot.key,
          label: slot.label,
          color: slot.themeDefault
            ? defaults.find(defaultSlot => defaultSlot.key === slot.key)?.color
            : slot.color,
        })),
      });
    }
  };

  const sources = settingsQuery.data?.sources || [];

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="dialog-grouping-field-settings">
        <DialogHeader>
          <DialogTitle>Widget settings</DialogTitle>
          <DialogDescription>
            Choose the fields and colour palette available to dashboard widgets
            for everyone in this tenant.
          </DialogDescription>
        </DialogHeader>

        {settingsQuery.isLoading || hiddenDraft === null || paletteDraft === null ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : settingsQuery.isError ? (
          <p className="text-sm text-destructive">
            {settingsQuery.error?.message || "Failed to load settings."}
          </p>
        ) : (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="fields" data-testid="tab-widget-fields">Fields</TabsTrigger>
              <TabsTrigger value="palette" data-testid="tab-widget-palette">Colour palette</TabsTrigger>
            </TabsList>
            <TabsContent value="fields" className="space-y-5 pt-3">
              <p className="text-sm text-muted-foreground">
                Untick a field to hide it from the widget builder. Existing
                widgets that already use a hidden field keep working.
              </p>
              {sources.map((source, i) => {
                const hidden = hiddenDraft[source.id] || new Set();
                const fields = [...source.fields].sort((a, b) =>
                  (a.label || "").localeCompare(b.label || "", undefined, {
                    sensitivity: "base",
                  }),
                );
                return (
                  <div key={source.id} className="space-y-2">
                    {i > 0 && <Separator />}
                    <p className="text-sm font-medium">{source.label}</p>
                    <div className="grid gap-1.5 sm:grid-cols-2">
                      {fields.map(f => (
                        <div key={f.key} className="flex items-center gap-2">
                          <Checkbox
                            id={`gfs-${source.id}-${f.key}`}
                            data-testid={`checkbox-field-${source.id}-${f.key}`}
                            checked={!hidden.has(f.key)}
                            onCheckedChange={checked =>
                              toggleField(source.id, f.key, checked === true)
                            }
                          />
                          <Label
                            htmlFor={`gfs-${source.id}-${f.key}`}
                            className="text-sm font-normal"
                          >
                            {f.label}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </TabsContent>
            <TabsContent value="palette" className="space-y-4 pt-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  Edit the five colour slots used by widget choices and
                  multi-series charts. Existing widgets keep their selected slot.
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={resetPalette}
                  data-testid="button-reset-widget-palette"
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset
                </Button>
              </div>
              <div className="space-y-3" data-testid="widget-palette-editor">
                {paletteDraft.map((slot, index) => {
                  const labelInvalid = !slot.label.trim();
                  const colorInvalid = !/^#[0-9a-f]{6}$/i.test(slot.color);
                  return (
                    <div
                      key={slot.key}
                      className="grid items-start gap-3 rounded-md border p-3 sm:grid-cols-[2rem_1fr_9rem]"
                    >
                      <div
                        className="mt-1 h-8 w-8 rounded-md border"
                        style={{ backgroundColor: colorInvalid ? "transparent" : slot.color }}
                        aria-label={`Colour ${index + 1} preview`}
                      />
                      <div className="space-y-1">
                        <Label htmlFor={`palette-label-${slot.key}`}>Label</Label>
                        <Input
                          id={`palette-label-${slot.key}`}
                          value={slot.label}
                          maxLength={40}
                          aria-invalid={labelInvalid}
                          onChange={event =>
                            updatePaletteSlot(slot.key, { label: event.target.value })
                          }
                          data-testid={`input-palette-label-${slot.key}`}
                        />
                        {labelInvalid && (
                          <p className="text-xs text-destructive">Enter a label.</p>
                        )}
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`palette-colour-${slot.key}`}>Colour</Label>
                        <div className="flex gap-2">
                          <Input
                            id={`palette-colour-${slot.key}`}
                            type="color"
                            value={colorInvalid ? "#000000" : slot.color}
                            className="h-9 w-12 cursor-pointer p-1"
                            onChange={event =>
                              updatePaletteSlot(slot.key, {
                                color: event.target.value,
                                themeDefault: false,
                              })
                            }
                            data-testid={`input-palette-colour-${slot.key}`}
                          />
                          <Input
                            value={slot.color}
                            aria-label={`${slot.label || slot.key} hex colour`}
                            aria-invalid={colorInvalid}
                            maxLength={7}
                            onChange={event =>
                              updatePaletteSlot(slot.key, {
                                color: event.target.value,
                                themeDefault: false,
                              })
                            }
                            data-testid={`input-palette-hex-${slot.key}`}
                          />
                        </div>
                        {colorInvalid && (
                          <p className="text-xs text-destructive">Use a six-digit hex colour.</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-field-settings">
            Cancel
          </Button>
          <Button
            onClick={activeTab === "palette" ? handleSavePalette : handleSave}
            disabled={
              saveMutation.isPending ||
              hiddenDraft === null ||
              paletteDraft === null ||
              (activeTab === "palette" && paletteErrors.length > 0)
            }
            data-testid="button-save-field-settings"
          >
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
