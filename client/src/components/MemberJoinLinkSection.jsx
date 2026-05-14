import { useMemo, useCallback } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Link2, Copy, Loader2, AlertCircle } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";

function normalizeKey(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/[\u2013\u2014]/g, '-')
    .trim()
    .toLowerCase();
}

function extractPrimitiveValue(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    // Some import paths store the value as a JSON-encoded scalar
    // (e.g. `"\"Partner\""`) rather than a raw string. Always try
    // JSON.parse first so we recover the underlying primitive — if it
    // fails (the common case for plain strings like `Partner`), fall
    // back to the trimmed original.
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed);
        // Only recurse when parse actually changed the shape; otherwise
        // a number/boolean/null parsed back to itself would loop.
        if (parsed !== trimmed) {
          return extractPrimitiveValue(parsed);
        }
      } catch {
        /* not JSON — fall through */
      }
    }
    return trimmed;
  }
  if (Array.isArray(val)) {
    return val.length > 0 ? extractPrimitiveValue(val[0]) : null;
  }
  if (typeof val === 'object' && val.value !== undefined) {
    return extractPrimitiveValue(val.value);
  }
  return val;
}

export default function MemberJoinLinkSection({ organizationId, showHeading = true }) {
  const { data: joinFormSetting, isLoading: defaultLoading, isError: defaultError } = useQuery({
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
    enabled: !!organizationId,
  });

  const { data: joinFormsByOrgTypeSetting, isLoading: byTypeLoading } = useQuery({
    queryKey: ['member-join-forms-by-org-type-setting'],
    queryFn: async () => {
      const settings = await base44.entities.SystemSettings.list({
        filter: { setting_key: 'member_join_forms_by_org_type' },
      });
      if (settings && settings.length > 0) {
        try {
          const parsed = JSON.parse(settings[0].setting_value);
          return { id: settings[0].id, value: parsed && typeof parsed === 'object' ? parsed : {} };
        } catch {
          return { id: settings[0].id, value: {} };
        }
      }
      return null;
    },
    enabled: !!organizationId,
  });

  const { data: orgScopedFields = [], isLoading: fieldsLoading } = useQuery({
    queryKey: ['org-preference-fields-for-join-link'],
    queryFn: async () => {
      try {
        const fields = await base44.entities.PreferenceField.list({
          filter: { is_active: true, entity_scope: 'organization' },
        });
        return fields || [];
      } catch {
        try {
          const all = await base44.entities.PreferenceField.list({ filter: { is_active: true } });
          return (all || []).filter(f => f.entity_scope === 'organization');
        } catch {
          return [];
        }
      }
    },
    enabled: !!organizationId,
  });

  const orgTypeField = useMemo(() => {
    return orgScopedFields.find(f =>
      f.name === 'org_type' || f.name === 'organisation_type' || f.name === 'organization_type'
    );
  }, [orgScopedFields]);

  const { data: orgPreferenceValues = [], isLoading: valuesLoading } = useQuery({
    queryKey: ['org-preference-values-for-join-link', organizationId],
    queryFn: async () => {
      try {
        const values = await base44.entities.OrganizationPreferenceValue.list({
          filter: { organization_id: organizationId },
        });
        return values || [];
      } catch {
        return [];
      }
    },
    enabled: !!organizationId && !!orgTypeField,
  });

  const orgTypeValue = useMemo(() => {
    if (!orgTypeField) return null;
    const match = orgPreferenceValues.find(v => v.preference_field_id === orgTypeField.id);
    if (!match) return null;
    return extractPrimitiveValue(match.value);
  }, [orgTypeField, orgPreferenceValues]);

  const normalizedOptions = useMemo(() => {
    const options = orgTypeField?.options;
    if (!Array.isArray(options) || options.length === 0) return [];
    return options.map(opt => {
      if (typeof opt === 'string') return { value: opt, label: opt };
      return { value: opt?.value ?? opt, label: opt?.label ?? opt?.value ?? opt };
    });
  }, [orgTypeField]);

  const resolveToOption = useCallback((raw) => {
    if (raw === null || raw === undefined || raw === '') return null;
    if (normalizedOptions.length === 0) return null;
    const rawStr = String(raw);
    const norm = normalizeKey(rawStr);
    return (
      normalizedOptions.find(o => String(o.value) === rawStr) ||
      normalizedOptions.find(o => normalizeKey(String(o.value)) === norm) ||
      normalizedOptions.find(o => normalizeKey(String(o.label)) === norm) ||
      null
    );
  }, [normalizedOptions]);

  const canonicalOrgTypeValue = useMemo(() => {
    if (orgTypeValue === null || orgTypeValue === undefined || orgTypeValue === '') return orgTypeValue;
    const matched = resolveToOption(orgTypeValue);
    return matched ? matched.value : orgTypeValue;
  }, [orgTypeValue, resolveToOption]);

  const isLoading = defaultLoading || byTypeLoading || fieldsLoading || valuesLoading;
  const isError = defaultError;

  const resolvedForm = useMemo(() => {
    const mapping = joinFormsByOrgTypeSetting?.value || {};
    const mappingKeys = Object.keys(mapping);
    const fallback = joinFormSetting?.value || null;
    if (mappingKeys.length === 0) return fallback;

    const normalizedIndex = {};
    for (const k of mappingKeys) {
      const norm = normalizeKey(k);
      if (norm && !(norm in normalizedIndex)) normalizedIndex[norm] = k;
    }
    const canonicalStr = (canonicalOrgTypeValue !== null && canonicalOrgTypeValue !== undefined && canonicalOrgTypeValue !== '')
      ? String(canonicalOrgTypeValue) : null;
    const rawStr = (orgTypeValue !== null && orgTypeValue !== undefined && orgTypeValue !== '')
      ? String(orgTypeValue) : null;
    if (canonicalStr && mapping[canonicalStr]?.id) return mapping[canonicalStr];
    if (canonicalStr) {
      const norm = normalizeKey(canonicalStr);
      const found = norm ? normalizedIndex[norm] : null;
      if (found && mapping[found]?.id) return mapping[found];
    }
    if (rawStr && rawStr !== canonicalStr) {
      const norm = normalizeKey(rawStr);
      const found = norm ? normalizedIndex[norm] : null;
      if (found && mapping[found]?.id) return mapping[found];
    }

    // Final pass: resolve each mapping key to an option (by value OR label,
    // case/whitespace-insensitive, JSON-encoded primitives unwrapped) and
    // match against the org's resolved option. Handles legacy mappings keyed
    // by option label instead of option value.
    const orgOption = resolveToOption(orgTypeValue);
    if (orgOption) {
      const targetValueStr = String(orgOption.value);
      for (const key of mappingKeys) {
        if (!mapping[key]?.id) continue;
        const keyPrimitive = extractPrimitiveValue(key);
        const keyOption = resolveToOption(keyPrimitive);
        if (keyOption && String(keyOption.value) === targetValueStr) {
          return mapping[key];
        }
      }
    }

    return fallback;
  }, [joinFormsByOrgTypeSetting, canonicalOrgTypeValue, orgTypeValue, joinFormSetting, resolveToOption]);

  const hasConfiguredForm = !!resolvedForm?.id;
  const slug = resolvedForm?.slug;
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

  if (isError) {
    return (
      <div className="space-y-2">
        {heading}
        <div className="flex items-start gap-2 text-xs text-muted-foreground" data-testid="text-join-link-error">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>Couldn't load the join form setting. Refresh to try again.</span>
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
