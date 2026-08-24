import { useEffect, useMemo } from "react";
import { Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

function statusValue(access) {
  if (typeof access === "string") return access.toLowerCase();
  return String(access?.status || access?.code || access?.reason || "").toLowerCase();
}

/**
 * The public form endpoint is authoritative for access. An absent __access
 * value means the form predates access policies and remains unrestricted.
 */
export function resolveFormAccess(form, isAuthenticated) {
  const access = form?.__access || form?.access;
  if (!access) return { restricted: false, anonymous: false };

  const status = statusValue(access);
  const explicitlyAllowed =
    access?.allowed === true ||
    ["allowed", "granted", "public", "unrestricted", "ok"].includes(status);
  if (explicitlyAllowed) return { restricted: false, anonymous: false };

  const explicitlyRestricted =
    access?.allowed === false ||
    access?.restricted === true ||
    [
      "denied", "forbidden", "restricted", "login_required",
      "authentication_required", "unauthenticated", "no_match",
      "form_access_denied", "tenant_mismatch", "access_lookup_failed",
    ].includes(status);

  return {
    restricted: explicitlyRestricted,
    anonymous: explicitlyRestricted && !isAuthenticated &&
      (access?.requires_authentication === true || status === "authentication_required"),
    message: access?.message || null,
  };
}

function currentReturnTo(framed) {
  if (framed) {
    try {
      return `${window.top.location.pathname}${window.top.location.search}${window.top.location.hash}`;
    } catch {
      // Cross-origin frame: use a same-origin referrer when possible.
    }
    try {
      if (document.referrer) {
        const referrer = new URL(document.referrer);
        if (referrer.origin === window.location.origin) {
          return `${referrer.pathname}${referrer.search}${referrer.hash}`;
        }
      }
    } catch {
      // Fall through to the form URL.
    }
  }
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export default function FormAccessRestriction({
  form,
  isAuthenticated,
  framed = false,
  standalone = false,
  className = "",
  style,
}) {
  const restriction = resolveFormAccess(form, isAuthenticated);
  const returnTo = useMemo(() => currentReturnTo(framed), [framed]);
  const loginHref = `/login?returnTo=${encodeURIComponent(returnTo)}`;

  useEffect(() => {
    if (restriction.anonymous && standalone && !framed) {
      window.location.replace(loginHref);
    }
  }, [restriction.anonymous, standalone, framed, loginHref]);

  if (!restriction.restricted) return null;

  if (restriction.anonymous && standalone && !framed) {
    return (
      <div className={`flex min-h-[200px] items-center justify-center p-4 ${className}`} style={style}>
        <div className="space-y-2 text-center" data-testid="form-access-login-redirect">
          <Loader2 className="mx-auto h-7 w-7 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Redirecting to login…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex min-h-[200px] items-center justify-center p-4 ${className}`} style={style}>
      <Card className="w-full max-w-md" data-testid="form-access-restricted">
        <CardContent className="space-y-3 pt-6 text-center">
          <Lock className="mx-auto h-9 w-9 text-slate-400" aria-hidden="true" />
          <p className="font-medium text-slate-800">
            {restriction.anonymous ? "Log in to access this form" : "This form is restricted"}
          </p>
          <p className="text-sm text-muted-foreground">
            {restriction.message || (restriction.anonymous
              ? "Sign in with your member account to continue."
              : "Your account does not have access to this form. If you think this is a mistake, please contact an administrator.")}
          </p>
          {restriction.anonymous && (
            <Button asChild className="w-full" data-testid="button-form-access-login">
              <a href={loginHref} target={framed ? "_top" : undefined}>Log in to continue</a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}