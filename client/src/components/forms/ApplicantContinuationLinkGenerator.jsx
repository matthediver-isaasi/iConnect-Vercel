import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { publicClient } from "@/api/publicClient";
import { listAllOrganizationsForAdmin } from "@/lib/adminOrgList";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function organizationItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

/**
 * Admin-only control for issuing an applicant continuation capability.
 * It deliberately copies, but never sends, the generated link.
 */
export default function ApplicantContinuationLinkGenerator({ form }) {
  const [organizationId, setOrganizationId] = useState("");
  const [generated, setGenerated] = useState(null);
  const [existingDraftUrl, setExistingDraftUrl] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const organizationsQuery = useQuery({
    queryKey: ["admin-applicant-continuation-organizations"],
    queryFn: () => listAllOrganizationsForAdmin({ sort: { name: "asc" } }),
    staleTime: 60 * 1000,
  });
  const organizations = useMemo(
    () => organizationItems(organizationsQuery.data),
    [organizationsQuery.data],
  );

  const generate = async () => {
    if (!form?.id || !form?.slug || !organizationId) return;
    setGenerating(true);
    setGenerated(null);
    try {
      const result = await publicClient.issueFormApplicantContinuation({
        formId: form.id,
        organizationId,
      });
      if (!result.resume_url) {
        throw new Error("The server did not provide a tenant-scoped applicant URL");
      }
      const generatedUrl = new URL(result.resume_url);
      const oldUrlText = existingDraftUrl.trim();
      if (oldUrlText) {
        const oldUrl = new URL(oldUrlText);
        const oldSlug = oldUrl.searchParams.get("slug");
        const oldResumeToken = oldUrl.searchParams.get("draft")
          || oldUrl.searchParams.get("resume_token");
        if (oldUrl.origin !== generatedUrl.origin || oldSlug !== form.slug || !oldResumeToken) {
          throw new Error("The Save & Continue link must be for this form on the same tenant website");
        }
        // A resume token restores answers only. The independently verified
        // applicant token in the generated URL remains the mutation authority.
        generatedUrl.searchParams.set("draft", oldResumeToken);
      }
      setGenerated({ url: generatedUrl.toString(), expiresAt: result.expires_at });
      setCopied(false);
    } catch (error) {
      toast.error(error.message || "Unable to generate a secure applicant link");
    } finally {
      setGenerating(false);
    }
  };

  const copy = async () => {
    if (!generated?.url) return;
    try {
      await navigator.clipboard.writeText(generated.url);
      setCopied(true);
      toast.success("Secure applicant link copied");
    } catch {
      toast.error("Unable to copy the link");
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-4" data-testid="applicant-continuation-link-generator">
      <div>
        <h3 className="text-sm font-semibold">Secure applicant continuation link</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Select the organisation this applicant may update. The link is not sent automatically.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="applicant-continuation-organization">Organisation</Label>
        <Select value={organizationId} onValueChange={(value) => {
          setOrganizationId(value);
          setGenerated(null);
          setCopied(false);
        }}>
          <SelectTrigger id="applicant-continuation-organization">
            <SelectValue placeholder={organizationsQuery.isLoading ? "Loading organisations…" : "Select an organisation"} />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((organization) => (
              <SelectItem key={organization.id} value={organization.id}>
                {organization.name || organization.display_name || organization.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {organizationsQuery.isError && (
          <p className="text-sm text-destructive" role="alert">
            Organisations could not be loaded. Check your administrator access and try again.
          </p>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="applicant-continuation-existing-draft">
          Existing Save &amp; Continue link (optional)
        </Label>
        <Input
          id="applicant-continuation-existing-draft"
          type="url"
          value={existingDraftUrl}
          onChange={(event) => {
            setExistingDraftUrl(event.target.value);
            setGenerated(null);
            setCopied(false);
          }}
          placeholder="https://tenant.example/FormView?slug=…&draft=…"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Use this to preserve answers from an older draft. The draft does not grant update access by itself.
        </p>
      </div>
      <Button type="button" variant="outline" onClick={generate} disabled={!organizationId || !form?.id || !form?.slug || generating}>
        {generating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
        Generate secure link
      </Button>
      {generated && (
        <div className="space-y-2 rounded-md bg-muted p-3" role="status">
          <p className="text-sm font-medium">Link ready to copy</p>
          <p className="text-xs text-muted-foreground">
            Expires {new Date(generated.expiresAt).toLocaleString()}. Generate a new link if it expires.
          </p>
          <Button type="button" size="sm" onClick={copy}>
            {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
    </div>
  );
}