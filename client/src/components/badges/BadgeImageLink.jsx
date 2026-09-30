import { useState } from "react";
import { Copy, Link } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { resolveBadgeImageLink } from "@/lib/badgeImageLink";
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "@/components/ui/dialog";

export default function BadgeImageLink({ badge }) {
  const [feedback, setFeedback] = useState("");
  const [copying, setCopying] = useState(false);
  const url = resolveBadgeImageLink(badge.image_url, import.meta.env.VITE_SUPABASE_URL);
  const available = typeof url === "string" && url.trim().length > 0;

  async function copyLink() {
    if (!available || copying) return;
    setCopying(true);
    setFeedback("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      setFeedback("Image link copied.");
    } catch {
      setFeedback("Could not copy automatically. Select the URL above and copy it manually (Ctrl+C or Command+C).");
    } finally {
      setCopying(false);
    }
  }

  return (
    <Dialog onOpenChange={() => setFeedback("")}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!available}
          title={available ? `Image link for ${badge.name}` : "No image available"}
          data-testid={`button-image-link-badge-${badge.id}`}
        >
          <Link className="w-4 h-4 mr-2" aria-hidden="true" />
          {available ? "Image link" : "No image"}
        </Button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100%-2rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader className="min-w-0">
          <DialogTitle>Badge image link</DialogTitle>
          <DialogDescription className="break-words pr-4">
            Public image URL for {badge.name}.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-2">
          <Label htmlFor={`badge-image-link-${badge.id}`}>Public image URL</Label>
          <Textarea
            id={`badge-image-link-${badge.id}`}
            value={available ? url : ""}
            readOnly
            rows={4}
            className="resize-none break-all"
            onFocus={(event) => event.target.select()}
          />
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {feedback || (available ? "You can also select and copy the URL manually." : "No image available.")}
          </p>
        </div>
        <DialogFooter className="gap-2">
          <DialogClose asChild><Button variant="outline">Close</Button></DialogClose>
          <Button onClick={copyLink} disabled={!available || copying}>
            <Copy className="w-4 h-4 mr-2" aria-hidden="true" />
            {copying ? "Copying…" : "Copy link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}