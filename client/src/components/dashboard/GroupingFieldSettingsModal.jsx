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
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/components/ui/use-toast";

/**
 * Admin-only checklist of each data source's fields. Unticked fields are
 * hidden per-tenant from the widget builder's option lists (enforced
 * server-side in the sources catalog). Widgets already configured with a
 * hidden field keep working — hiding only trims the option list.
 */
export default function GroupingFieldSettingsModal({ open, onClose }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  // Local draft of the hidden map: { [sourceId]: Set(fieldKey) }.
  const [hiddenDraft, setHiddenDraft] = useState(null);

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
      return;
    }
    if (settingsQuery.data && hiddenDraft === null) {
      const seed = {};
      for (const [sourceId, keys] of Object.entries(settingsQuery.data.hidden || {})) {
        seed[sourceId] = new Set(keys);
      }
      setHiddenDraft(seed);
    }
  }, [open, settingsQuery.data, hiddenDraft]);

  const saveMutation = useMutation({
    mutationFn: async hidden =>
      apiRequest("PUT", "/api/dashboard/hidden-fields", { hidden }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/dashboard/hidden-fields"] });
      // The builder's catalog reflects the change on next fetch.
      qc.invalidateQueries({ queryKey: ["/api/dashboard/sources"] });
      toast({ title: "Grouping fields updated" });
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
    saveMutation.mutate(payload);
  };

  const sources = settingsQuery.data?.sources || [];

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="dialog-grouping-field-settings">
        <DialogHeader>
          <DialogTitle>Widget builder fields</DialogTitle>
          <DialogDescription>
            Untick a field to hide it from the widget builder&rsquo;s field
            pickers for everyone in this tenant. Existing widgets that
            already use a hidden field keep working.
          </DialogDescription>
        </DialogHeader>

        {settingsQuery.isLoading || hiddenDraft === null ? (
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
          <div className="space-y-5">
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
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="button-cancel-field-settings">
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending || hiddenDraft === null}
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
