import { useEffect, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, XCircle, Landmark } from "lucide-react";

// Return pages for the GoCardless hosted Billing Request Flow.
// /membership/direct-debit/complete  — payer finished the bank set-up
// /membership/direct-debit/cancelled — payer exited without completing
export default function DirectDebitReturn({ outcome }) {
  const location = useLocation();
  const memberId = new URLSearchParams(location.search).get("member_id");
  const [agreement, setAgreement] = useState(null);
  const [loading, setLoading] = useState(outcome === "complete" && !!memberId);

  useEffect(() => {
    if (outcome !== "complete" || !memberId) return;
    let cancelled = false;
    fetch(`/api/membership/direct-debit?memberId=${encodeURIComponent(memberId)}`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (!cancelled) setAgreement(json?.agreement || null); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [outcome, memberId]);

  const isComplete = outcome === "complete";

  return (
    <div className="max-w-lg mx-auto px-4 py-16">
      <Card data-testid="card-dd-return">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            {loading ? (
              <>
                <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Checking your Direct Debit set-up...</p>
              </>
            ) : isComplete ? (
              <>
                <CheckCircle2 className="h-12 w-12 text-green-500" />
                <div>
                  <p className="text-lg font-medium" data-testid="text-dd-return-title">Direct Debit set-up complete</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    Thank you — your bank details have been submitted. Your mandate is being
                    confirmed with your bank, and your membership will be activated
                    automatically. You will receive an email confirmation shortly.
                  </p>
                  {agreement?.terms && (
                    <p className="text-sm text-muted-foreground mt-2" data-testid="text-dd-return-terms">
                      Plan: {agreement.terms.instalment_count} monthly payments of{" "}
                      {agreement.terms.currency === "GBP" ? "\u00a3" : `${agreement.terms.currency} `}
                      {Number(agreement.terms.monthly_amount).toFixed(2)}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <XCircle className="h-12 w-12 text-muted-foreground" />
                <div>
                  <p className="text-lg font-medium" data-testid="text-dd-return-title">Direct Debit set-up not completed</p>
                  <p className="text-sm text-muted-foreground mt-2">
                    You exited before completing the bank authorisation. No Direct Debit has
                    been set up and nothing has been charged. You can restart the set-up at
                    any time from the membership payment page.
                  </p>
                </div>
              </>
            )}
            <div className="flex items-center gap-2 flex-wrap justify-center">
              <Button asChild variant="outline" data-testid="button-dd-return-home">
                <Link to="/">
                  <Landmark className="mr-2 h-4 w-4" />
                  Return to site
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
