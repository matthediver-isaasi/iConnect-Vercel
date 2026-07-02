import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

export default function SignupVerify() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const email = params.get("email");
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [tenant, setTenant] = useState(null);

  useEffect(() => {
    if (!token || !email) {
      setState("error");
      setError("This verification link is missing required information.");
      return;
    }
    (async () => {
      try {
        const resp = await fetch("/api/public/signup-verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ token, email }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          setState("error");
          setError(data.error || "Verification failed.");
          return;
        }
        setTenant(data.tenant);
        setState("success");
      } catch (err) {
        setState("error");
        setError("Network error. Please try again.");
      }
    })();
  }, [token, email]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          {state === "loading" && (
            <>
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
              <CardTitle className="mt-4">Verifying your email…</CardTitle>
              <CardDescription>Setting up your workspace.</CardDescription>
            </>
          )}
          {state === "success" && (
            <>
              <div className="mx-auto w-12 h-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-green-600 dark:text-green-400" />
              </div>
              <CardTitle className="mt-4">Workspace created</CardTitle>
              <CardDescription>Let's finish setting things up.</CardDescription>
            </>
          )}
          {state === "error" && (
            <>
              <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertCircle className="w-6 h-6 text-destructive" />
              </div>
              <CardTitle className="mt-4">Verification failed</CardTitle>
            </>
          )}
        </CardHeader>
        <CardContent>
          {state === "error" && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {state === "success" && tenant && (
            <p className="text-sm text-muted-foreground text-center">
              Continue to <strong>{tenant.name}</strong> at{" "}
              <span className="text-primary">{tenant.slug}.iconn.app</span>
            </p>
          )}
        </CardContent>
        <CardFooter>
          {state === "success" && tenant && (
            <Button
              className="w-full"
              data-testid="button-continue-onboarding"
              onClick={() => {
                window.location.href = `${tenant.portalUrl}${tenant.adminPath || "/admin/onboarding"}`;
              }}
            >
              Continue to setup
            </Button>
          )}
          {state === "error" && (
            <Button className="w-full" variant="outline" onClick={() => (window.location.href = "/signup")}>
              Start over
            </Button>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
