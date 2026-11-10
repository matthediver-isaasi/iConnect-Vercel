import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Loader2 } from 'lucide-react';
import MemberGraceWarning from './MemberGraceWarning';
import { overviewTermExpiry, validTermDate } from '../../../shared/membershipTermExpiry.js';
export { overviewTermExpiry } from '../../../shared/membershipTermExpiry.js';

export default function MemberMembershipOverview({ memberId, enabled = true }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['member-membership', memberId],
    enabled: enabled && !!memberId,
    queryFn: async () => {
      const response = await fetch(`/api/membership/member-membership?memberId=${encodeURIComponent(memberId)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Membership status unavailable');
      return response.json();
    },
    refetchInterval: 60000,
  });
  const expiry = overviewTermExpiry(data);
  const validDate = validTermDate(expiry);
  return <>
    <div className="flex items-center gap-3">
      <CalendarDays className="w-4 h-4 text-slate-400" aria-hidden="true" />
      <div>
        <p className="text-xs text-slate-500">Current term expiry</p>
        <p className="text-sm font-medium" data-testid="text-member-current-term-expiry">
          {isLoading ? <span role="status" className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading membership…</span>
            : error ? 'Unable to load membership'
            : validDate ? expiry.split('-').reverse().join('/')
            : 'No confirmed term expiry'}
        </p>
      </div>
    </div>
    <MemberGraceWarning memberId={memberId} enabled={enabled} />
  </>;
}
