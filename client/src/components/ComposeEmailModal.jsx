import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, Send } from 'lucide-react';
import { useToast } from '@/components/ui/use-toast';
import {
  normalizeMemberEmailAddress,
  parseMemberEmailCc,
} from '@shared/memberEmailRecipients.mjs';

export default function ComposeEmailModal({ 
  open, 
  onOpenChange, 
  memberId, 
  tenantId,
  memberEmail, 
  memberName,
  onSuccess 
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [cc, setCc] = useState('');
  const [recipient, setRecipient] = useState('');
  const [recipientError, setRecipientError] = useState('');
  const [ccError, setCcError] = useState('');
  const [deliveryUncertain, setDeliveryUncertain] = useState(false);
  const contextKey = `${tenantId || ''}\u0000${memberId || ''}\u0000${memberEmail || ''}`;
  const contextRef = useRef(contextKey);
  const wasOpenRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const requestGenerationRef = useRef(0);

  const resetDraft = () => {
    setSubject('');
    setBody('');
    setCc('');
    setCcError('');
    setRecipient('');
    setRecipientError('');
    setDeliveryUncertain(false);
    sendInFlightRef.current = false;
    setSending(false);
  };

  useEffect(() => {
    const changed = contextRef.current !== contextKey;
    contextRef.current = contextKey;
    if (changed) {
      requestGenerationRef.current += 1;
      resetDraft();
      if (open) onOpenChange(false);
    }
  }, [contextKey, onOpenChange, open]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      resetDraft();
      try {
        setRecipient(normalizeMemberEmailAddress(memberEmail));
      } catch (error) {
        setRecipientError(error.message || 'This member does not have a valid email address.');
      }
    } else if (!open && wasOpenRef.current) {
      requestGenerationRef.current += 1;
      resetDraft();
    }
    wasOpenRef.current = open;
  }, [memberEmail, open]);

  useEffect(() => () => {
    requestGenerationRef.current += 1;
    contextRef.current = '__unmounted__';
    sendInFlightRef.current = false;
  }, []);

  const handleOpenChange = (nextOpen) => {
    // Radix can request closure from its built-in X, Escape, or outside click.
    // Keep the controlled dialog open while delivery is unresolved so closing
    // and reopening cannot clear the synchronous duplicate-send fence.
    if (!nextOpen && sendInFlightRef.current) return;
    if (!nextOpen) {
      requestGenerationRef.current += 1;
      resetDraft();
    }
    onOpenChange(nextOpen);
  };

  const handleCcChange = (event) => {
    const value = event.target.value;
    setCc(value);
    try {
      parseMemberEmailCc(value);
      setCcError('');
    } catch (error) {
      setCcError(error.message || 'Enter CC recipients as plain email addresses separated by commas or semicolons.');
    }
  };

  const handleSend = async () => {
    if (!subject.trim() || !body.trim()) {
      toast({
        title: 'Missing Fields',
        description: 'Please enter a subject and message body',
        variant: 'destructive',
      });
      return;
    }

    let ccRecipients;
    try {
      ccRecipients = parseMemberEmailCc(cc);
      setCcError('');
    } catch (error) {
      setCcError(error.message || 'Enter CC recipients as plain email addresses separated by commas or semicolons.');
      return;
    }

    if (!tenantId || !memberId || !recipient || recipientError) {
      toast({
        title: 'Recipient Requires Review',
        description: recipientError || 'The member or organisation context is unavailable. Close this draft and refresh before sending.',
        variant: 'destructive',
      });
      return;
    }
    if (sendInFlightRef.current || deliveryUncertain) return;

    const requestContext = contextKey;
    const requestGeneration = ++requestGenerationRef.current;
    sendInFlightRef.current = true;
    setSending(true);
    try {
      const response = await fetch('/api/outlook/send', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
        body: JSON.stringify({
          tenantId,
          memberId,
          to: recipient,
          cc: ccRecipients.join(', '),
          subject: subject.trim(),
          body: body.trim(),
          bodyType: 'text'
        })
      });

      const data = await response.json();
      if (
        contextRef.current !== requestContext
        || requestGenerationRef.current !== requestGeneration
      ) return;

      if (data?.deliveryUnknown === true) {
        setDeliveryUncertain(true);
        toast({
          title: 'Delivery Status Unknown',
          description: 'Microsoft may have accepted this email, but delivery could not be confirmed. To avoid a duplicate, do not send this draft again; check Sent Items or refresh email history first.',
          variant: 'destructive',
        });
      } else if (response.ok) {
        toast({
          title: 'Email Sent',
          description: data.warning
            ? `Microsoft accepted the email to ${recipient}. ${data.warning}`
            : `Microsoft accepted the email to ${recipient}.`,
        });
        // Delivery is confirmed, so the pending-request dismissal fence can
        // be released before deliberately closing the successful draft.
        sendInFlightRef.current = false;
        handleOpenChange(false);
        onSuccess?.();
      } else {
        const staleRecipient = response.status === 409
          || data?.code === 'MEMBER_EMAIL_CHANGED'
          || data?.code === 'STALE_MEMBER_EMAIL';
        toast({
          title: staleRecipient ? 'Recipient Requires Review' : 'Failed to Send',
          description: staleRecipient
            ? `${data.error || 'The member recipient changed while this draft was open'}. Nothing was sent. Close this draft and refresh the member before reviewing the recipient.`
            : (data.error || 'Could not send email'),
          variant: 'destructive',
        });
      }
    } catch (err) {
      if (
        contextRef.current !== requestContext
        || requestGenerationRef.current !== requestGeneration
      ) return;
      setDeliveryUncertain(true);
      toast({
        title: 'Delivery Status Unknown',
        description: 'The connection ended before delivery could be confirmed. To avoid a duplicate, do not send this draft again; check Sent Items or refresh email history first.',
        variant: 'destructive',
      });
    } finally {
      if (
        contextRef.current === requestContext
        && requestGenerationRef.current === requestGeneration
      ) {
        sendInFlightRef.current = false;
        setSending(false);
      }
    }
  };

  let parsedCc = [];
  if (!ccError) {
    try {
      parsedCc = parseMemberEmailCc(cc);
    } catch {
      parsedCc = [];
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[600px]"
        onEscapeKeyDown={(event) => {
          if (sendInFlightRef.current) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (sendInFlightRef.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (sendInFlightRef.current) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Compose Email</DialogTitle>
          <DialogDescription>
            Review the exact recipients before sending{memberName ? ` to ${memberName}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <Input
              id="to"
              value={recipient}
              disabled
              className="bg-muted"
              data-testid="input-email-to"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cc">CC (optional)</Label>
            <Input
              id="cc"
              value={cc}
              onChange={handleCcChange}
              placeholder="one@example.com, two@example.com"
              aria-invalid={ccError ? 'true' : undefined}
              data-testid="input-email-cc"
            />
            {ccError && <p className="text-sm text-destructive" role="alert">{ccError}</p>}
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-sm" data-testid="email-recipient-summary">
            <p><span className="font-medium">To:</span> {recipient || 'Recipient unavailable'}</p>
            <p><span className="font-medium">CC:</span> {parsedCc.length ? parsedCc.join(', ') : 'None'}</p>
            {recipientError && <p className="mt-2 text-destructive" role="alert">{recipientError}</p>}
            {deliveryUncertain && (
              <p className="mt-2 text-destructive" role="alert">
                Delivery could not be confirmed. Check Sent Items or refresh email history before composing another message.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Enter subject..."
              data-testid="input-email-subject"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="body">Message</Label>
            <Textarea
              id="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message..."
              rows={8}
              data-testid="input-email-body"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={sending}
            data-testid="button-cancel-email"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={sending || deliveryUncertain || !!recipientError || !!ccError || !recipient || !subject.trim() || !body.trim()}
            data-testid="button-send-email"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            Send Email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
