import { useState, useEffect, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Loader2, Users, UserPlus, UserMinus, Clock, CheckCircle2,
  AlertCircle, CalendarDays, MapPin, Lock, Mail, RefreshCw
} from "lucide-react";

function formatDate(dateStr, timezone) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleString('en-GB', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: timezone || 'Europe/London'
    });
  } catch {
    return new Date(dateStr).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' });
  }
}

function CutoffCountdown({ cutoffDate }) {
  const [timeLeft, setTimeLeft] = useState('');
  const [isUrgent, setIsUrgent] = useState(false);

  useEffect(() => {
    if (!cutoffDate) return;
    const update = () => {
      const now = new Date();
      const cutoff = new Date(cutoffDate);
      const diff = cutoff - now;
      if (diff <= 0) {
        setTimeLeft('Closed');
        setIsUrgent(true);
        return;
      }
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      if (days > 0) {
        setTimeLeft(`${days}d ${hours}h remaining`);
        setIsUrgent(days < 2);
      } else if (hours > 0) {
        setTimeLeft(`${hours}h ${minutes}m remaining`);
        setIsUrgent(true);
      } else {
        setTimeLeft(`${minutes}m remaining`);
        setIsUrgent(true);
      }
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [cutoffDate]);

  if (!cutoffDate) return null;

  return (
    <div className={`flex items-center gap-2 text-sm ${isUrgent ? 'text-destructive font-medium' : 'text-muted-foreground'}`}>
      <Clock className="w-4 h-4" />
      <span>{timeLeft}</span>
    </div>
  );
}

export default function GroupBookingPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [newEmail, setNewEmail] = useState('');
  const [newFirstName, setNewFirstName] = useState('');
  const [newLastName, setNewLastName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState(null);
  const [addSuccess, setAddSuccess] = useState(null);

  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/group-booking/${token}`);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || 'Failed to load group booking');
      }
      const result = await res.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchData();
  }, [token, fetchData]);

  const handleAddParticipant = async (e) => {
    e.preventDefault();
    setAddError(null);
    setAddSuccess(null);

    if (!newEmail.trim()) {
      setAddError('Please enter an email address.');
      return;
    }

    setAdding(true);
    try {
      const res = await fetch(`/api/public/group-booking/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail.trim(),
          first_name: newFirstName.trim() || null,
          last_name: newLastName.trim() || null
        })
      });

      const result = await res.json();

      if (!res.ok) {
        setAddError(result.error || 'Failed to add participant');
        return;
      }

      setAddSuccess(`${newEmail.trim()} has been added.`);
      setNewEmail('');
      setNewFirstName('');
      setNewLastName('');
      await fetchData();

      setTimeout(() => setAddSuccess(null), 4000);
    } catch (err) {
      setAddError('Something went wrong. Please try again.');
    } finally {
      setAdding(false);
    }
  };

  const handleRemoveParticipant = async (participantId) => {
    setRemoveError(null);
    setRemovingId(participantId);
    try {
      const res = await fetch(`/api/public/group-booking/${token}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participant_id: participantId })
      });

      const result = await res.json();

      if (!res.ok) {
        setRemoveError(result.error || 'Failed to remove participant');
        return;
      }

      await fetchData();
    } catch (err) {
      setRemoveError('Something went wrong. Please try again.');
    } finally {
      setRemovingId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background" data-testid="loading-group-booking">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <h2 className="text-lg font-semibold mb-2" data-testid="text-error-title">Booking Not Found</h2>
            <p className="text-muted-foreground" data-testid="text-error-message">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const { booking, event, ticket_class, participants, cutoff_date, is_past_cutoff, spots_remaining, tenant } = data;
  const isLocked = is_past_cutoff || booking.status !== 'active';
  const isFull = spots_remaining <= 0;

  const tenantLogo = tenant?.logo_url;
  const tenantName = tenant?.name;
  const primaryColor = tenant?.primary_color;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-4 sm:p-6 space-y-4">
        {/* Tenant Header */}
        <div className="flex items-center gap-3 py-2">
          {tenantLogo && (
            <img
              src={tenantLogo}
              alt={tenantName || 'Logo'}
              className="h-10 w-auto object-contain"
              data-testid="img-tenant-logo"
            />
          )}
          {tenantName && !tenantLogo && (
            <span className="text-lg font-semibold" data-testid="text-tenant-name">{tenantName}</span>
          )}
        </div>

        {/* Event Info & Status */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div>
                <CardTitle className="text-xl" data-testid="text-event-title">
                  {event?.title || 'Group Booking'}
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1" data-testid="text-booking-ref">
                  Ref: {booking.booking_reference}
                </p>
              </div>
              <Badge variant={isLocked ? 'secondary' : 'default'} data-testid="badge-booking-status">
                {isLocked ? (is_past_cutoff ? 'Closed' : 'Inactive') : 'Active'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {event && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <CalendarDays className="w-4 h-4" />
                  <span data-testid="text-event-date">{formatDate(event.start_date, event.timezone)}</span>
                </div>
                {event.location && (
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4" />
                    <span data-testid="text-event-location">{event.location}</span>
                  </div>
                )}
              </div>
            )}

            <Separator />

            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium" data-testid="text-participants-count">
                  {participants.length} / {booking.group_size} participants
                </span>
              </div>
              {cutoff_date && <CutoffCountdown cutoffDate={cutoff_date} />}
            </div>

            {/* Capacity bar */}
            <div className="w-full bg-muted rounded-full h-2.5" data-testid="progress-capacity">
              <div
                className="h-2.5 rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (participants.length / booking.group_size) * 100)}%`,
                  backgroundColor: primaryColor || 'hsl(var(--primary))'
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {isFull ? 'All spots have been filled.' : `${spots_remaining} spot${spots_remaining !== 1 ? 's' : ''} remaining`}
            </p>

            {ticket_class && (
              <p className="text-sm text-muted-foreground" data-testid="text-ticket-class">
                Ticket: {ticket_class.name}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Locked message */}
        {isLocked && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3 text-muted-foreground">
                <Lock className="w-5 h-5" />
                <div>
                  <p className="font-medium">This group booking is now closed</p>
                  <p className="text-sm">
                    {is_past_cutoff
                      ? `The cut-off date (${formatDate(cutoff_date)}) has passed. No further changes can be made.`
                      : 'This booking is no longer active.'}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Add participant form */}
        {!isLocked && !isFull && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <UserPlus className="w-5 h-5" />
                Add Participant
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleAddParticipant} className="space-y-3">
                <div>
                  <Label htmlFor="participant-email">Email address *</Label>
                  <Input
                    id="participant-email"
                    type="email"
                    placeholder="participant@example.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    disabled={adding}
                    required
                    data-testid="input-participant-email"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="participant-first-name">First name</Label>
                    <Input
                      id="participant-first-name"
                      placeholder="First name"
                      value={newFirstName}
                      onChange={(e) => setNewFirstName(e.target.value)}
                      disabled={adding}
                      data-testid="input-participant-first-name"
                    />
                  </div>
                  <div>
                    <Label htmlFor="participant-last-name">Last name</Label>
                    <Input
                      id="participant-last-name"
                      placeholder="Last name"
                      value={newLastName}
                      onChange={(e) => setNewLastName(e.target.value)}
                      disabled={adding}
                      data-testid="input-participant-last-name"
                    />
                  </div>
                </div>
                <Button type="submit" disabled={adding} data-testid="button-add-participant">
                  {adding ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <UserPlus className="w-4 h-4 mr-2" />}
                  Add to Group
                </Button>
              </form>

              {addError && (
                <div className="mt-3 flex items-center gap-2 text-sm text-destructive" data-testid="text-add-error">
                  <AlertCircle className="w-4 h-4" />
                  {addError}
                </div>
              )}
              {addSuccess && (
                <div className="mt-3 flex items-center gap-2 text-sm text-green-600 dark:text-green-400" data-testid="text-add-success">
                  <CheckCircle2 className="w-4 h-4" />
                  {addSuccess}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Participants List */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-5 h-5" />
              Participants ({participants.length})
            </CardTitle>
            <Button size="icon" variant="ghost" onClick={fetchData} data-testid="button-refresh-participants">
              <RefreshCw className="w-4 h-4" />
            </Button>
          </CardHeader>
          <CardContent>
            {participants.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-no-participants">
                No participants added yet. Use the form above to add people to your group.
              </p>
            ) : (
              <div className="space-y-2">
                {participants.map((p, idx) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2 p-3 rounded-md bg-muted/50"
                    data-testid={`row-participant-${p.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary/10 text-primary text-sm font-medium shrink-0">
                        {idx + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate" data-testid={`text-participant-name-${p.id}`}>
                          {[p.first_name, p.last_name].filter(Boolean).join(' ') || 'Name not provided'}
                        </p>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Mail className="w-3 h-3" />
                          <span className="truncate" data-testid={`text-participant-email-${p.id}`}>{p.email}</span>
                        </div>
                      </div>
                    </div>
                    {!isLocked && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRemoveParticipant(p.id)}
                        disabled={removingId === p.id}
                        data-testid={`button-remove-participant-${p.id}`}
                      >
                        {removingId === p.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <UserMinus className="w-4 h-4 text-destructive" />
                        )}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {removeError && (
              <div className="mt-3 flex items-center gap-2 text-sm text-destructive" data-testid="text-remove-error">
                <AlertCircle className="w-4 h-4" />
                {removeError}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Footer */}
        <p className="text-xs text-center text-muted-foreground py-2">
          Booked by {booking.booker_email}
          {cutoff_date && !is_past_cutoff && (
            <> &middot; Changes allowed until {formatDate(cutoff_date)}</>
          )}
        </p>
      </div>
    </div>
  );
}
