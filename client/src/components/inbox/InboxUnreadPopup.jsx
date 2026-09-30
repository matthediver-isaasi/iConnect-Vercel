import React from "react";
import { Mail } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// One-time login popup that lets a member know they have unread inbox messages.
// The X / Escape / click-outside paths all route through Radix's onOpenChange
// and are treated as a soft dismiss (session-only). "View messages" and
// "Don't remind me about these" are explicit and handled by their own callbacks.
export default function InboxUnreadPopup({
  open,
  unreadCount,
  latestSubject,
  onViewMessages,
  onDontRemind,
  onSoftClose,
  onShown,
}) {
  const count = unreadCount || 0;
  const messageWord = count === 1 ? "message" : "messages";

  // Fire onShown only when the popup is actually mounted AND open, so the
  // session/"don't remind" watermarks are written at display time and never
  // when the popup was suppressed (e.g. a layout branch that didn't mount it).
  React.useEffect(() => {
    if (open) onShown?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onSoftClose?.();
      }}
    >
      <DialogContent className="max-w-md" data-testid="dialog-inbox-unread">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
              <Mail className="h-5 w-5" />
            </div>
            <DialogTitle data-testid="text-unread-count">
              You have {count} new {messageWord}
            </DialogTitle>
          </div>
          {latestSubject && (
            <DialogDescription className="pt-2">
              Latest:{" "}
              <span className="font-medium text-foreground" data-testid="text-latest-subject">
                {latestSubject}
              </span>
            </DialogDescription>
          )}
        </DialogHeader>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="ghost"
            onClick={() => onDontRemind?.()}
            data-testid="button-dont-remind"
          >
            Don't remind me about these
          </Button>
          <Button
            variant="default"
            onClick={() => onViewMessages?.()}
            data-testid="button-view-messages"
          >
            View messages
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
