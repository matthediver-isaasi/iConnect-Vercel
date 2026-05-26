import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/components/ui/use-toast";
import { CheckCircle2, Circle, Loader2, Trash2 } from "lucide-react";

export default function OnboardingChecklist() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [removing, setRemoving] = useState(false);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/admin/onboarding-checklist", { credentials: "include" });
      if (resp.ok) setData(await resp.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const removeSamples = async () => {
    if (!confirm("Remove all sample content from your workspace? This can't be undone.")) return;
    setRemoving(true);
    try {
      const resp = await fetch("/api/admin/sample-content", { method: "DELETE", credentials: "include" });
      if (resp.ok) {
        toast({ title: "Sample content removed" });
        load();
      } else {
        toast({ title: "Could not remove sample content", variant: "destructive" });
      }
    } finally {
      setRemoving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;
  const { progress, checklist, sample_content_present } = data;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Card data-testid="card-onboarding-checklist">
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Getting started</CardTitle>
            <CardDescription>{progress.done} of {progress.total} done</CardDescription>
          </div>
          <Badge variant="secondary">{pct}%</Badge>
        </div>
        <Progress value={pct} className="mt-2" />
      </CardHeader>
      <CardContent className="space-y-2">
        {checklist.map(item => (
          <div
            key={item.key}
            className="flex items-center justify-between gap-3 rounded-md border p-3"
            data-testid={`checklist-item-${item.key}`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {item.done
                ? <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0" />
                : <Circle className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
              <span className={`text-sm truncate ${item.done ? "text-muted-foreground line-through" : ""}`}>
                {item.label}
              </span>
              {item.intent === "not_needed" && !item.done && (
                <Badge variant="outline" className="ml-2">skipped</Badge>
              )}
            </div>
            {!item.done && item.link && (
              <Button variant="ghost" size="sm" onClick={() => (window.location.href = item.link)} data-testid={`button-checklist-${item.key}`}>
                Open
              </Button>
            )}
          </div>
        ))}

        {sample_content_present && (
          <div className="pt-3 border-t mt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={removeSamples}
              disabled={removing}
              data-testid="button-remove-sample-content"
            >
              {removing
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Removing…</>
                : <><Trash2 className="w-4 h-4 mr-2" />Remove sample content</>}
            </Button>
            <p className="text-xs text-muted-foreground mt-2">
              Your workspace was seeded with a few example items so the modules don't look empty. Remove them once you're ready.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
