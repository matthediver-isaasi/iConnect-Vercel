import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicClient } from '@/api/publicClient';
import { isReservedMemberSlug } from '@shared/memberAliases.js';

// Tenant-configurable terminology for "Member"/"Members" (presentation only —
// database tables, API routes and feature keys are unchanged). Mirrors the
// article rename pattern (ArticleUrlContext / article_display_name).
// Setting: system_settings.member_display_name = {"singular":"Contact","plural":"Contacts"}

export function slugifyMemberTerm(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export const DEFAULT_MEMBER_TERMS = { singular: 'Member', plural: 'Members' };

export function parseMemberDisplayNameSetting(rawValue) {
  if (!rawValue) return DEFAULT_MEMBER_TERMS;
  try {
    const parsed = JSON.parse(rawValue);
    if (parsed && typeof parsed === 'object') {
      const singular = typeof parsed.singular === 'string' && parsed.singular.trim()
        ? parsed.singular.trim() : DEFAULT_MEMBER_TERMS.singular;
      const plural = typeof parsed.plural === 'string' && parsed.plural.trim()
        ? parsed.plural.trim() : DEFAULT_MEMBER_TERMS.plural;
      return { singular, plural };
    }
  } catch {
    // Tolerate a plain-string value (treated as the plural term).
    const plural = String(rawValue).trim();
    if (plural) {
      return {
        singular: plural.toLowerCase().endsWith('s') ? plural.slice(0, -1) : plural,
        plural,
      };
    }
  }
  return DEFAULT_MEMBER_TERMS;
}

function buildValue(terms, isLoading) {
  const memberLabel = terms.singular;
  const memberLabelPlural = terms.plural;
  const slug = slugifyMemberTerm(memberLabelPlural);
  // A slug that would shadow an existing app route (e.g. "Events") keeps the
  // custom labels but falls back to the canonical /members URL.
  const isCustomSlug = !!slug && slug !== 'members' && !isReservedMemberSlug(slug);
  const listPath = isCustomSlug ? `/${slug}` : '/members';
  return {
    memberLabel,
    memberLabelPlural,
    memberSlug: isCustomSlug ? slug : 'members',
    isCustomSlug,
    isLoading,
    listPath,
    getMemberListUrl: () => listPath,
    getMemberDetailUrl: (id) => `${listPath}/${id}`,
  };
}

const MemberTerminologyContext = createContext(buildValue(DEFAULT_MEMBER_TERMS, true));

export function MemberTerminologyProvider({ children }) {
  const { data: terms, isLoading } = useQuery({
    queryKey: ['member-terminology-settings'],
    queryFn: async () => {
      try {
        const setting = await publicClient.getSystemSetting('member_display_name');
        return parseMemberDisplayNameSetting(setting?.setting_value);
      } catch (error) {
        console.error('Error loading member display name:', error);
        return DEFAULT_MEMBER_TERMS;
      }
    },
    staleTime: 5000,
    refetchOnWindowFocus: true,
  });

  const value = useMemo(
    () => buildValue(terms || DEFAULT_MEMBER_TERMS, isLoading),
    [terms, isLoading]
  );

  return (
    <MemberTerminologyContext.Provider value={value}>
      {children}
    </MemberTerminologyContext.Provider>
  );
}

export function useMemberTerminology() {
  return useContext(MemberTerminologyContext);
}
