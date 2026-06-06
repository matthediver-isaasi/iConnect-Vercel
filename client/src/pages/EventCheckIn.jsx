import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { getFlagColorClasses } from "@/lib/flagColors";
import { CheckCircle2, XCircle, LogIn, Loader2, CalendarClock, MapPin, Ticket, Mic, Star, Utensils, AlertTriangle, Accessibility, Flag, FileText } from "lucide-react";

function getInitials(first, last, email) {
  const a = (first || "").trim();
  const b = (last || "").trim();
  if (a || b) return `${a.charAt(0)}${b.charAt(0)}`.toUpperCase() || "?";
  return (email || "?").charAt(0).toUpperCase();
}

function formatDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

export default function EventCheckIn() {
  const { toast } = useToast();
  const [token, setToken] = useState("");
  const [state, setState] = useState("loading"); // loading | ok | unauthenticated | denied | notfound | error
  const [resolved, setResolved] = useState(null);
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken((params.get("token") || "").trim());
  }, []);

  const loadToken = useCallback(async (tok) => {
    setState("loading");
    try {
      const res = await apiRequest("GET", `/api/admin/event-checkin?token=${encodeURIComponent(tok)}`);
      setResolved(res.data);
      setState("ok");
    } catch (err) {
      if (err.status === 401) setState("unauthenticated");
      else if (err.status === 403) setState("denied");
      else if (err.status === 404) setState("notfound");
      else setState("error");
    }
  }, []);

  useEffect(() => {
    if (token) loadToken(token);
    else if (token === "") {
      // wait for the effect that reads the URL; only show notfound once resolved empty
    }
  }, [token, loadToken]);

  const handleMark = async () => {
    setMarking(true);
    try {
      const res = await apiRequest("POST", "/api/admin/event-checkin", { action: "mark", token });
      setResolved(res.data);
      if (res.alreadyCheckedIn) {
        toast({ title: "Already checked in", description: "This attendee was already marked as attended." });
      } else {
        toast({ title: "Checked in", description: "Attendee marked as attended." });
      }
    } catch (err) {
      toast({ title: "Check-in failed", description: err.message, variant: "destructive" });
    } finally {
      setMarking(false);
    }
  };

  const loginUrl = `/Login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;

  return (
    <div className="min-h-[70vh] flex items-start justify-center p-4">
      <div className="w-full max-w-md mt-8 space-y-4">
        <div className="text-center space-y-1">
          <h1 className="text-xl font-semibold" data-testid="text-checkin-title">Event Check-In</h1>
          <p className="text-sm text-muted-foreground">Scan to mark attendance at the door.</p>
        </div>

        {state === "loading" && (
          <Card>
            <CardContent className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> Loading…
            </CardContent>
          </Card>
        )}

        {state === "unauthenticated" && (
          <Card>
            <CardContent className="py-8 text-center space-y-4">
              <LogIn className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">You need to sign in as staff to check attendees in.</p>
              <Button asChild data-testid="button-login">
                <a href={loginUrl}>Sign in to continue</a>
              </Button>
            </CardContent>
          </Card>
        )}

        {state === "denied" && (
          <Card>
            <CardContent className="py-8 text-center space-y-2">
              <XCircle className="h-8 w-8 mx-auto text-destructive" />
              <p className="text-sm text-muted-foreground" data-testid="text-denied">
                Your account does not have permission to check attendees in.
              </p>
            </CardContent>
          </Card>
        )}

        {state === "notfound" && (
          <Card>
            <CardContent className="py-8 text-center space-y-2">
              <XCircle className="h-8 w-8 mx-auto text-destructive" />
              <p className="text-sm text-muted-foreground" data-testid="text-invalid">
                This check-in code is invalid or has expired.
              </p>
            </CardContent>
          </Card>
        )}

        {state === "error" && (
          <Card>
            <CardContent className="py-8 text-center space-y-3">
              <XCircle className="h-8 w-8 mx-auto text-destructive" />
              <p className="text-sm text-muted-foreground">Something went wrong loading this code.</p>
              <Button variant="outline" onClick={() => token && loadToken(token)} data-testid="button-retry">Retry</Button>
            </CardContent>
          </Card>
        )}

        {state === "ok" && resolved && (
          <Card data-testid="card-attendee">
            <CardHeader className="space-y-3">
              {Array.isArray(resolved.flags) && resolved.flags.length > 0 && (
                <div className="space-y-2" data-testid="container-attendee-flags">
                  {resolved.flags.map((flag) => {
                    const flagColors = getFlagColorClasses(flag.color);
                    return (
                    <div
                      key={flag.field_id}
                      className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 ${flagColors.surface}`}
                      data-testid={`banner-flag-${flag.field_id}`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Flag className="h-5 w-5 shrink-0" />
                        <span className="font-semibold truncate" data-testid={`text-flag-${flag.field_id}`}>{flag.label}</span>
                      </div>
                      {flag.form_submission_id && (
                        <Button
                          asChild
                          size="icon"
                          variant="outline"
                          className={`shrink-0 bg-background/20 ${flagColors.border}`}
                          data-testid={`button-view-flag-${flag.field_id}`}
                        >
                          <a
                            href={`/FormSubmission/${flag.form_submission_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="View form submission"
                          >
                            <FileText className="h-4 w-4" />
                          </a>
                        </Button>
                      )}
                    </div>
                    );
                  })}
                </div>
              )}
              {(resolved.attendee?.isSpeaker || resolved.attendee?.designation) && (
                <div className="space-y-2" data-testid="container-attendee-indicators">
                  {resolved.attendee?.isSpeaker && (
                    <div
                      className="flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-primary-foreground"
                      data-testid="banner-speaker"
                    >
                      <Mic className="h-5 w-5 shrink-0" />
                      <span className="font-semibold">
                        Speaker{resolved.attendee?.speakerName ? ` · ${resolved.attendee.speakerName}` : ""}
                      </span>
                    </div>
                  )}
                  {resolved.attendee?.designation && (
                    <div
                      className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-accent-foreground"
                      data-testid="banner-designation"
                    >
                      <Star className="h-5 w-5 shrink-0" />
                      <span className="font-semibold" data-testid="text-attendee-designation">{resolved.attendee.designation}</span>
                    </div>
                  )}
                </div>
              )}
              {(() => {
                const dietary = Array.isArray(resolved.attendee?.dietary_selections) ? resolved.attendee.dietary_selections.filter(Boolean) : [];
                const allergies = Array.isArray(resolved.attendee?.allergy_selections) ? resolved.attendee.allergy_selections.filter((a) => a && a.name) : [];
                const accessibility = Array.isArray(resolved.attendee?.accessibility_selections) ? resolved.attendee.accessibility_selections.filter(Boolean) : [];
                if (dietary.length === 0 && allergies.length === 0 && accessibility.length === 0) return null;
                return (
                  <div className="space-y-2" data-testid="container-attendee-options">
                    {dietary.length > 0 && (
                      <div className="flex items-start gap-2 rounded-md bg-warning px-3 py-2 text-warning-foreground" data-testid="banner-dietary">
                        <Utensils className="h-5 w-5 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold uppercase tracking-wide opacity-80">Dietary</div>
                          <div className="font-medium" data-testid="text-attendee-dietary">{dietary.join(", ")}</div>
                        </div>
                      </div>
                    )}
                    {allergies.length > 0 && (
                      <div className="flex items-start gap-2 rounded-md bg-destructive px-3 py-2 text-destructive-foreground" data-testid="banner-allergies">
                        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold uppercase tracking-wide opacity-80">Allergies</div>
                          <div className="font-medium" data-testid="text-attendee-allergies">
                            {allergies.map((a) => a.severity ? `${a.name} (${a.severity})` : a.name).join(", ")}
                          </div>
                        </div>
                      </div>
                    )}
                    {accessibility.length > 0 && (
                      <div className="flex items-start gap-2 rounded-md bg-accent px-3 py-2 text-accent-foreground" data-testid="banner-accessibility">
                        <Accessibility className="h-5 w-5 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold uppercase tracking-wide opacity-80">Accessibility</div>
                          <div className="font-medium" data-testid="text-attendee-accessibility">{accessibility.join(", ")}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
              <CardTitle className="flex items-center gap-2">
                <Avatar className="h-9 w-9 shrink-0">
                  {resolved.attendee?.profile_photo_url && (
                    <AvatarImage
                      src={resolved.attendee.profile_photo_url}
                      alt=""
                      data-testid="img-attendee-avatar"
                    />
                  )}
                  <AvatarFallback className="bg-muted text-muted-foreground">
                    {getInitials(
                      resolved.attendee?.first_name,
                      resolved.attendee?.last_name,
                      resolved.attendee?.email
                    )}
                  </AvatarFallback>
                </Avatar>
                <span data-testid="text-attendee-name">
                  {[resolved.attendee?.first_name, resolved.attendee?.last_name].filter(Boolean).join(" ") || "Attendee"}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm">
                {resolved.attendee?.email && (
                  <div className="text-muted-foreground" data-testid="text-attendee-email">{resolved.attendee.email}</div>
                )}
                <div className="flex items-start gap-2">
                  <CalendarClock className="h-4 w-4 mt-0.5 text-muted-foreground" />
                  <div>
                    <div className="font-medium" data-testid="text-event-title">{resolved.event?.title}</div>
                    {resolved.event?.start_date && (
                      <div className="text-muted-foreground">{formatDate(resolved.event.start_date)}</div>
                    )}
                  </div>
                </div>
                {resolved.session && (
                  <div className="flex items-start gap-2">
                    <Ticket className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div>
                      <div className="font-medium" data-testid="text-session-title">{resolved.session.title}</div>
                      {resolved.session.track_name && (
                        <Badge variant="secondary" className="mt-1">{resolved.session.track_name}</Badge>
                      )}
                    </div>
                  </div>
                )}
                {(resolved.session?.location || resolved.event?.location) && (
                  <div className="flex items-start gap-2">
                    <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
                    <div className="text-muted-foreground">{resolved.session?.location || resolved.event?.location}</div>
                  </div>
                )}
                {resolved.ticketClassName && (
                  <div className="text-muted-foreground">Ticket: {resolved.ticketClassName}</div>
                )}
              </div>

              {resolved.alreadyCheckedIn ? (
                <div className="rounded-md border border-green-200 bg-green-50 p-4 text-center space-y-1 dark:border-green-900 dark:bg-green-950/30" data-testid="status-already">
                  <CheckCircle2 className="h-6 w-6 mx-auto text-green-700 dark:text-green-400" />
                  <div className="font-medium text-green-800 dark:text-green-100">Already checked in</div>
                  {resolved.checkedInAt && (
                    <div className="text-xs text-muted-foreground">{formatDate(resolved.checkedInAt)}</div>
                  )}
                </div>
              ) : (
                <Button className="w-full" onClick={handleMark} disabled={marking} data-testid="button-mark-attended">
                  {marking ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  Mark attended
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
