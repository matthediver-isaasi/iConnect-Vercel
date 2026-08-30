import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";
import { publicClient } from "@/api/publicClient";
import { sendTeamMemberInvite } from "@/api/functions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import ReactQuill from "react-quill";
import "react-quill/dist/quill.snow.css";
import {
  isInviteTemplateResolutionPending,
  shouldInitializeInviteTemplate,
} from "@/lib/inviteMemberTemplate";

/**
 * Shared invite-member dialog usable from both the /Team page and the
 * Organisation detail view.
 *
 * Props:
 *   open                {boolean}   - Dialog open state
 *   onOpenChange        {function}  - Called with new open state
 *   targetOrganization  {object}    - The org to invite into: { id, name }
 *   memberInfo          {object}    - The logged-in inviter's member record
 *   organizationInfo    {object}    - The inviter's own org (used for fallback
 *                                     placeholder values only)
 *   existingMembers     {array}     - Optional list of members already in the
 *                                     target org so we can client-side reject
 *                                     duplicates before hitting the server.
 */
export default function InviteMemberDialog({
  open,
  onOpenChange,
  targetOrganization,
  memberInfo,
  organizationInfo,
  existingMembers = [],
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteSubject, setInviteSubject] = useState("");
  const [inviteBody, setInviteBody] = useState("");
  const templateInitializedRef = useRef(false);

  // ------------------------------------------------------------------
  // Resolve invite template from the inviter's role (same as Team page)
  // ------------------------------------------------------------------
  const {
    data: roles = [],
    isPending: rolesPending,
    isFetching: rolesFetching,
  } = useQuery({
    queryKey: ["roles-for-invite-dialog"],
    queryFn: () => base44.entities.Role.list(),
    enabled: open,
  });

  const inviterRole = useMemo(() => {
    if (!memberInfo?.role_id || !roles.length) return null;
    return roles.find((r) => r.id === memberInfo.role_id) || null;
  }, [memberInfo?.role_id, roles]);

  const inviteTemplateId = inviterRole?.invite_email_template_id || null;

  const {
    data: inviteTemplate,
    isPending: templatePending,
    isFetching: templateFetching,
  } = useQuery({
    queryKey: ["email-template", inviteTemplateId],
    queryFn: async () => {
      if (!inviteTemplateId) return null;
      const templates = await base44.entities.EmailTemplate.list();
      return templates.find((t) => t.id === inviteTemplateId) || null;
    },
    enabled: !!inviteTemplateId && open,
  });

  const templateResolutionPending = isInviteTemplateResolutionPending({
    hasRoleId: !!memberInfo?.role_id,
    rolesPending,
    rolesFetching,
    inviteTemplateId,
    templatePending,
    templateFetching,
  });

  // ------------------------------------------------------------------
  // Verified domains for the TARGET organisation (not the inviter's org)
  // ------------------------------------------------------------------
  const { data: targetOrgDomainsData } = useQuery({
    queryKey: ["org-verified-domains", targetOrganization?.id],
    queryFn: async () =>
      (await publicClient.getOrganizationDomains(targetOrganization?.id)) ||
      null,
    enabled: !!targetOrganization?.id && open,
  });

  const targetOrgVerifiedDomains = useMemo(() => {
    const apiDomains = targetOrgDomainsData?.verified_domains || [];
    return apiDomains.map((d) => d.toLowerCase());
    // When the target org has NO verified domains, we allow any email domain
    // (an admin explicitly chose this org — no domain restriction is sensible).
  }, [targetOrgDomainsData]);

  // ------------------------------------------------------------------
  // Placeholder substitution — resolve against target org
  // ------------------------------------------------------------------
  const replaceAllPlaceholders = (text) => {
    if (!text) return text;
    const inviterFirst = memberInfo?.first_name || "";
    const inviterLast = memberInfo?.last_name || "";
    const inviterFull = [inviterFirst, inviterLast].filter(Boolean).join(" ");
    // Target org details take priority over inviter's own org
    const orgName = targetOrganization?.name || organizationInfo?.name || "";
    const orgId = targetOrganization?.id || memberInfo?.organization_id || "";

    let result = text;
    result = result.replace(/\{\{inviter_name\}\}/gi, inviterFull);
    result = result.replace(/\{\{organization_name\}\}/gi, orgName);
    result = result.replace(/\{\{organization_id\}\}/gi, orgId);

    result = result.replace(/\[\[member\.full_name\]\]/gi, inviterFull);
    result = result.replace(/\[\[member_full_name\]\]/gi, inviterFull);
    result = result.replace(/\[\[member\.first_name\]\]/gi, inviterFirst);
    result = result.replace(/\[\[member_first_name\]\]/gi, inviterFirst);
    result = result.replace(/\[\[member\.last_name\]\]/gi, inviterLast);
    result = result.replace(/\[\[member_last_name\]\]/gi, inviterLast);
    result = result.replace(/\[\[member\.email\]\]/gi, memberInfo?.email || "");
    result = result.replace(/\[\[member_email\]\]/gi, memberInfo?.email || "");
    result = result.replace(/\[\[organization\.name\]\]/gi, orgName);
    result = result.replace(/\[\[organization_name\]\]/gi, orgName);
    result = result.replace(/\[\[organization\.id\]\]/gi, orgId);
    result = result.replace(/\[\[organization_id\]\]/gi, orgId);
    return result;
  };

  // Each opening gets one initialization only. Query refetches and parent
  // rerenders must not overwrite edits after the form becomes interactive.
  useEffect(() => {
    if (open) return;
    templateInitializedRef.current = false;
    setInviteEmail("");
    setInviteSubject("");
    setInviteBody("");
  }, [open]);

  useEffect(() => {
    if (!shouldInitializeInviteTemplate({
      open,
      initialized: templateInitializedRef.current,
      resolutionPending: templateResolutionPending,
    })) return;

    templateInitializedRef.current = true;
    const inviterFull = [memberInfo?.first_name, memberInfo?.last_name]
      .filter(Boolean)
      .join(" ");
    const orgName = targetOrganization?.name || organizationInfo?.name || "";

    if (inviteTemplate) {
      setInviteSubject(
        replaceAllPlaceholders(
          inviteTemplate.subject || "You have been invited to join our team"
        )
      );
      setInviteBody(replaceAllPlaceholders(inviteTemplate.body || ""));
    } else {
      setInviteSubject(`You're invited to join ${orgName || "our team"}`);
      setInviteBody(
        `<p>Hi,</p><p>${inviterFull} has invited you to join ${orgName || "our team"}.</p><p>Click the link below to accept the invitation and set up your account:</p><p style="margin: 20px 0; text-align: center;"><a href="{{invite_link}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Accept Invitation</a></p>`
      );
    }
    // Placeholder inputs are intentionally captured at initialization time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, templateResolutionPending, inviteTemplate]);

  // ------------------------------------------------------------------
  // Send invite mutation
  // ------------------------------------------------------------------
  const sendInviteMutation = useMutation({
    mutationFn: async ({ email, subject, body }) => {
      const response = await sendTeamMemberInvite({
        email,
        inviterName: `${memberInfo?.first_name || ""} ${memberInfo?.last_name || ""}`.trim(),
        inviterEmail: memberInfo?.email,
        emailSubject: subject,
        emailBody: body,
        organizationId: memberInfo?.organization_id,
        // Explicit target org so the backend uses it instead of the inviter's org
        targetOrganizationId: targetOrganization?.id,
      });
      if (!response.success) {
        throw new Error(response.error || "Failed to send invitation");
      }
      return response;
    },
    onSuccess: () => {
      toast.success("Invitation sent successfully");
      onOpenChange(false);
      setInviteEmail("");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to send invitation");
    },
  });

  // ------------------------------------------------------------------
  // Domain hint UI
  // ------------------------------------------------------------------
  const primaryDomain = targetOrgVerifiedDomains[0] || "";
  const hasDomainRestriction = targetOrgVerifiedDomains.length > 0;

  const domainHint = hasDomainRestriction
    ? targetOrgVerifiedDomains.length > 1
      ? `Allowed domains: ${targetOrgVerifiedDomains.map((d) => `@${d}`).join(", ")}`
      : `Email domain must match: @${primaryDomain}`
    : "No domain restriction — any email address is accepted for this organisation.";

  // ------------------------------------------------------------------
  // Handle send
  // ------------------------------------------------------------------
  const handleSendInvite = () => {
    if (!inviteEmail) {
      toast.error("Please enter an email address");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail)) {
      toast.error("Please enter a valid email address");
      return;
    }

    // Domain validation — only enforce when the target org has domains configured
    if (hasDomainRestriction) {
      const inviteDomain = inviteEmail.split("@")[1].toLowerCase();
      if (!targetOrgVerifiedDomains.includes(inviteDomain)) {
        const domainList = targetOrgVerifiedDomains
          .map((d) => `@${d}`)
          .join(", ");
        toast.error(`Email domain must be one of: ${domainList}`);
        return;
      }
    }

    // Client-side duplicate guard against the already-fetched member list
    if (existingMembers.length > 0) {
      const alreadyMember = existingMembers.find(
        (m) => m.email?.toLowerCase() === inviteEmail.toLowerCase()
      );
      if (alreadyMember) {
        toast.error("This person is already a member of this organisation");
        return;
      }
    }

    const finalBody = inviteBody.replace(
      /\{\{invitee_email\}\}/gi,
      inviteEmail
    );
    sendInviteMutation.mutate({
      email: inviteEmail,
      subject: inviteSubject,
      body: finalBody,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100vh-1rem)] max-h-[calc(100dvh-1rem)] w-[calc(100%-1rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="invite-member-dialog"
      >
        <DialogHeader className="shrink-0 px-4 pb-3 pt-5 pr-12 sm:px-6 sm:pr-12 sm:pt-6">
          <DialogTitle>Invite Member</DialogTitle>
          <DialogDescription>
            Send an invitation to a new member
            {targetOrganization?.name ? ` of ${targetOrganization.name}` : ""}.
            You can customise the email before sending.
          </DialogDescription>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
          data-testid="invite-member-scroll-region"
        >
          {templateResolutionPending ? (
            <div
              className="flex min-h-[280px] items-center justify-center gap-2 text-sm text-slate-600"
              role="status"
              data-testid="invite-template-loading"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading invitation template...
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="invite-email-addr">Recipient Email Address *</Label>
                <Input
                  id="invite-email-addr"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={hasDomainRestriction ? `user@${primaryDomain}` : "user@example.com"}
                  data-testid="input-invite-email"
                />
                <p className="text-xs text-slate-500">{domainHint}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-email-subject">Email Subject</Label>
                <Input
                  id="invite-email-subject"
                  type="text"
                  value={inviteSubject}
                  onChange={(e) => setInviteSubject(e.target.value)}
                  placeholder="Enter email subject"
                  data-testid="input-invite-subject"
                />
              </div>

              <div className="space-y-2">
                <Label>Email Body</Label>
                <p className="text-xs text-slate-500 mb-2">
                  Available placeholders: {"{{invitee_email}}"},{" "}
                  {"{{inviter_name}}"}, {"{{organization_name}}"},{"{{invite_link}}"}
                </p>
                <div className="rounded-md border [&_.ql-container]:min-h-[200px]">
                  <ReactQuill
                    theme="snow"
                    value={inviteBody}
                    onChange={setInviteBody}
                    className="min-h-[200px]"
                    modules={{
                      toolbar: [
                        [{ header: [1, 2, 3, false] }],
                        ["bold", "italic", "underline"],
                        [{ list: "ordered" }, { list: "bullet" }],
                        ["link"],
                        ["clean"],
                      ],
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t bg-background px-4 py-4 sm:px-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSendInvite}
            disabled={templateResolutionPending || sendInviteMutation.isPending || !inviteEmail}
            className="bg-blue-600 hover:bg-blue-700"
            data-testid="button-send-invite"
          >
            {sendInviteMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Mail className="w-4 h-4 mr-2" />
                Send Invitation
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
