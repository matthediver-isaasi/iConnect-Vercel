import React, { useState, useEffect, useCallback } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, User, ArrowRight, Check, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

export default function TransferTicketDialog({ open, onOpenChange, booking, bookingSource = 'regular', onSuccess, isPublicBooking = false }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const [targetEmail, setTargetEmail] = useState("");
  const [targetFirstName, setTargetFirstName] = useState("");
  const [targetLastName, setTargetLastName] = useState("");
  const [targetOrganisation, setTargetOrganisation] = useState("");
  const [targetPhone, setTargetPhone] = useState("");
  const [emailCheckResult, setEmailCheckResult] = useState(null);
  const [checkingEmail, setCheckingEmail] = useState(false);

  const { data: systemSettings = [] } = useQuery({
    queryKey: ['system-settings'],
    queryFn: () => base44.entities.SystemSettings.list(),
    staleTime: 60000,
  });
  const restrictByRole = (() => {
    const setting = systemSettings.find(s => s.setting_key === 'transfer_restrict_by_role');
    return !setting || setting.setting_value !== 'false';
  })();

  useEffect(() => {
    if (!open) {
      setReason("");
      setSearchQuery("");
      setSearchResults([]);
      setSelectedMember(null);
      setSubmitting(false);
      setTargetEmail("");
      setTargetFirstName("");
      setTargetLastName("");
      setTargetOrganisation("");
      setTargetPhone("");
      setEmailCheckResult(null);
      setCheckingEmail(false);
    }
  }, [open]);

  useEffect(() => {
    if (!isPublicBooking || !targetEmail || targetEmail.length < 3 || !targetEmail.includes('@')) {
      setEmailCheckResult(null);
      return;
    }

    const timer = setTimeout(async () => {
      setCheckingEmail(true);
      try {
        const params = new URLSearchParams({ email: targetEmail.trim() });
        const response = await fetch(`/api/booking-transfer-requests/check-email?${params.toString()}`, {
          credentials: 'include',
        });
        if (response.ok) {
          const data = await response.json();
          setEmailCheckResult(data);
        }
      } catch (err) {
        console.error('Email check error:', err);
      } finally {
        setCheckingEmail(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [targetEmail, isPublicBooking]);

  const searchMembers = useCallback(async (query) => {
    if (!query || query.length < 2 || !booking?.id) {
      setSearchResults([]);
      return;
    }

    setSearching(true);
    try {
      const params = new URLSearchParams({ booking_id: booking.id, q: query });
      const response = await fetch(`/api/booking-transfer-requests/eligible-members?${params.toString()}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Search failed');
      }

      const members = await response.json();
      setSearchResults(members);
    } catch (err) {
      console.error('Member search error:', err);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [booking?.id]);

  useEffect(() => {
    if (isPublicBooking) return;
    const timer = setTimeout(() => {
      searchMembers(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, searchMembers, isPublicBooking]);

  const handleSubmit = async () => {
    if (!booking?.id) return;

    if (isPublicBooking) {
      if (!targetEmail || !targetFirstName || !targetLastName) return;
      if (emailCheckResult?.exists) return;
    } else {
      if (!selectedMember?.id) return;
    }

    setSubmitting(true);
    try {
      const body = isPublicBooking
        ? {
            booking_id: booking.id,
            target_email: targetEmail.trim(),
            target_first_name: targetFirstName.trim(),
            target_last_name: targetLastName.trim(),
            target_organisation: targetOrganisation.trim() || null,
            target_phone: targetPhone.trim() || null,
            reason: reason.trim() || null,
            booking_source: bookingSource,
          }
        : {
            booking_id: booking.id,
            target_member_id: selectedMember.id,
            reason: reason.trim() || null,
            booking_source: bookingSource,
          };

      const response = await fetch('/api/booking-transfer-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to submit transfer request');
      }

      toast.success('Transfer request submitted');
      queryClient.invalidateQueries({ queryKey: ['my-transfer-requests'] });
      onOpenChange(false);
      if (onSuccess) onSuccess();
    } catch (error) {
      console.error('Transfer request error:', error);
      toast.error(error.message || 'Failed to submit transfer request');
    } finally {
      setSubmitting(false);
    }
  };

  const attendeeName = booking
    ? [booking.attendee_first_name, booking.attendee_last_name].filter(Boolean).join(' ') || booking.attendee_email || 'Unknown'
    : '';

  const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email?.trim() || '');
  const publicFormValid = isValidEmail(targetEmail) && targetFirstName.trim() && targetLastName.trim() && !emailCheckResult?.exists;
  const memberFormValid = !!selectedMember;
  const canSubmit = isPublicBooking ? publicFormValid : memberFormValid;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer Ticket</DialogTitle>
          <DialogDescription>
            {isPublicBooking
              ? 'Transfer this ticket to another person. Enter their details below. The request will be reviewed before it takes effect.'
              : `Transfer this ticket to another eligible member within the same organisation${restrictByRole ? ' and role' : ''}. The request will be reviewed before it takes effect.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="p-3 bg-slate-50 rounded-md border border-slate-200">
            <p className="text-xs font-medium text-slate-500 mb-1">Current attendee</p>
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium text-slate-700" data-testid="text-current-attendee">{attendeeName}</span>
            </div>
          </div>

          {isPublicBooking ? (
            <div className="space-y-3">
              <label className="text-sm font-medium">Transfer to</label>

              <div className="space-y-2">
                <Input
                  placeholder="Email address *"
                  type="email"
                  value={targetEmail}
                  onChange={(e) => setTargetEmail(e.target.value)}
                  data-testid="input-target-email"
                />
                {checkingEmail && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Checking email...
                  </div>
                )}
                {emailCheckResult?.exists && (
                  <div className="flex items-center gap-2 p-2 bg-warning/10 border border-warning/30 rounded-md">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                    <p className="text-xs text-warning">
                      This email belongs to an existing member. Please use the standard member transfer flow instead.
                    </p>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="First name *"
                  value={targetFirstName}
                  onChange={(e) => setTargetFirstName(e.target.value)}
                  data-testid="input-target-first-name"
                />
                <Input
                  placeholder="Last name *"
                  value={targetLastName}
                  onChange={(e) => setTargetLastName(e.target.value)}
                  data-testid="input-target-last-name"
                />
              </div>

              <Input
                placeholder="Organisation (optional)"
                value={targetOrganisation}
                onChange={(e) => setTargetOrganisation(e.target.value)}
                data-testid="input-target-organisation"
              />

              <Input
                placeholder="Phone number (optional)"
                type="tel"
                value={targetPhone}
                onChange={(e) => setTargetPhone(e.target.value)}
                data-testid="input-target-phone"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Transfer to
              </label>
              {selectedMember ? (
                <div className="flex items-center justify-between gap-2 p-3 bg-blue-50 border border-blue-200 rounded-md">
                  <div className="flex items-center gap-2 min-w-0">
                    <Check className="w-4 h-4 text-blue-600 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-blue-900 truncate" data-testid="text-selected-member">
                        {selectedMember.first_name} {selectedMember.last_name}
                      </p>
                      <p className="text-xs text-blue-700 truncate">{selectedMember.email}</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setSelectedMember(null); setSearchQuery(""); setSearchResults([]); }}
                    data-testid="button-change-member"
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by name or email..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-9"
                      data-testid="input-search-member"
                    />
                  </div>

                  {searching && (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                    </div>
                  )}

                  {!searching && searchQuery.length >= 2 && searchResults.length === 0 && (
                    <p className="text-sm text-slate-500 text-center py-3" data-testid="text-no-results">
                      No eligible members found
                    </p>
                  )}

                  {!searching && searchResults.length > 0 && (
                    <div className="max-h-48 overflow-y-auto space-y-1 border border-slate-200 rounded-md p-1">
                      {searchResults.map((m) => (
                        <button
                          key={m.id}
                          className="w-full flex items-center gap-3 p-2 rounded hover-elevate text-left"
                          onClick={() => setSelectedMember(m)}
                          data-testid={`button-select-member-${m.id}`}
                        >
                          <User className="w-4 h-4 text-slate-400 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900 truncate">
                              {m.first_name} {m.last_name}
                            </p>
                            <p className="text-xs text-slate-500 truncate">{m.email}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {!isPublicBooking && selectedMember && (
            <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-md border border-slate-200">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-xs text-slate-500 truncate">{attendeeName}</span>
                <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="text-xs font-medium text-slate-700 truncate">
                  {selectedMember.first_name} {selectedMember.last_name}
                </span>
              </div>
            </div>
          )}

          {isPublicBooking && targetFirstName && targetLastName && targetEmail && !emailCheckResult?.exists && (
            <div className="flex items-center gap-2 p-3 bg-slate-50 rounded-md border border-slate-200">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-xs text-slate-500 truncate">{attendeeName}</span>
                <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" />
                <span className="text-xs font-medium text-slate-700 truncate">
                  {targetFirstName} {targetLastName}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Reason (optional)
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you requesting this transfer?"
              className="resize-none"
              rows={3}
              data-testid="input-transfer-reason"
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-testid="button-transfer-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !canSubmit}
            data-testid="button-transfer-submit"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Submitting...
              </>
            ) : (
              'Submit Transfer Request'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
