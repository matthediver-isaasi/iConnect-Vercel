import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link2, Copy, Loader2 } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";

export default function MemberJoinLinkSection({ organizationId, showHeading = true }) {
  const { data: joinFormSetting, isLoading } = useQuery({
    queryKey: ['member-join-form-setting'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'member_join_form' },
      });
      if (settings && settings.length > 0) {
        try {
          return { id: settings[0].id, value: JSON.parse(settings[0].setting_value) };
        } catch {
          return { id: settings[0].id, value: null };
        }
      }
      return null;
    },
  });

  const hasConfiguredForm = !!joinFormSetting?.value?.id;
  const slug = joinFormSetting?.value?.slug;
  const joinFormUrl = slug && organizationId
    ? `${window.location.origin}${createPageUrl('FormView')}?slug=${encodeURIComponent(slug)}&organization_id=${encodeURIComponent(organizationId)}`
    : null;

  const handleCopy = async () => {
    if (!joinFormUrl) return;
    try {
      await navigator.clipboard.writeText(joinFormUrl);
      toast.success('Join link copied to clipboard');
    } catch {
      toast.error('Failed to copy link');
    }
  };

  const heading = showHeading ? (
    <div className="flex items-center gap-2 text-sm font-medium" data-testid="heading-join-link">
      <Link2 className="w-4 h-4" />
      Member Join Link
    </div>
  ) : null;

  if (isLoading) {
    return (
      <div className="space-y-2">
        {heading}
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-join-link-loading">
          <Loader2 className="w-3 h-3 animate-spin" />
          Loading join link…
        </div>
      </div>
    );
  }

  if (joinFormUrl) {
    return (
      <div className="space-y-2">
        {heading}
        <p className="text-xs text-muted-foreground">
          Share this link with prospective members. The form is prefilled with this organisation.
        </p>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            value={joinFormUrl}
            className="flex-1 font-mono text-xs"
            onFocus={(e) => e.target.select()}
            data-testid="input-join-form-url"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            data-testid="button-copy-join-form-url"
          >
            <Copy className="w-3 h-3 mr-1" />
            Copy
          </Button>
        </div>
      </div>
    );
  }

  if (hasConfiguredForm && !slug) {
    return (
      <div className="space-y-2">
        {heading}
        <div className="text-xs text-muted-foreground" data-testid="text-join-form-missing-slug">
          <p>The configured join form has no public slug, so a shareable link can't be generated.</p>
          <p className="mt-1">
            Pick a different form in{' '}
            <Link to={createPageUrl('MemberPreferences')} className="underline font-medium">
              Member Preferences
            </Link>{' '}
            &rarr; Join, or add a slug to that form in the form builder.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {heading}
      <div className="text-xs text-muted-foreground" data-testid="text-join-form-empty">
        <p>No join form configured yet.</p>
        <p className="mt-1">
          Choose a form in{' '}
          <Link to={createPageUrl('MemberPreferences')} className="underline font-medium">
            Member Preferences
          </Link>{' '}
          &rarr; Join to enable a shareable link here.
        </p>
      </div>
    </div>
  );
}
