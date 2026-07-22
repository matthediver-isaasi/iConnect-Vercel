import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMemberTerminology } from '@/contexts/MemberTerminologyContext';
import { BUILTIN_MEMBER_ALIASES, isReservedMemberSlug } from '@shared/memberAliases.js';

// Redirects a custom members-list slug (e.g. /constituents) to the canonical
// /members routes. Built-in aliases (contacts, individuals, people) have real
// routes registered in index.jsx, so this only fires for other custom terms.
// Mirrors DynamicArticleRedirector.
export function DynamicMemberRedirector({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { isCustomSlug, memberSlug, isLoading } = useMemberTerminology();

  useEffect(() => {
    if (isLoading || !isCustomSlug) return;
    if (BUILTIN_MEMBER_ALIASES.includes(memberSlug)) return;
    // Never hijack an existing app route (e.g. plural term "Events").
    if (isReservedMemberSlug(memberSlug)) return;

    // Only remap the two member-list shapes: /<slug> and /<slug>/<id>.
    const segments = location.pathname.split('/').filter(Boolean);
    if (segments.length < 1 || segments.length > 2) return;
    if (segments[0].toLowerCase() !== memberSlug) return;

    if (segments.length === 1) {
      navigate(`/members${location.search}`, { replace: true });
    } else {
      navigate(`/members/${segments[1]}${location.search}`, { replace: true });
    }
  }, [isLoading, isCustomSlug, memberSlug, location.pathname, location.search, navigate]);

  return children;
}
