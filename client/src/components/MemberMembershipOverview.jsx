import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Loader2 } from 'lucide-react';
import MemberGraceWarning from './MemberGraceWarning';

// Use persisted terms from the Membership tab, never a simulated renewal quote.
export function overviewTermExpiry(data, today = new Date().toISOString().slice(0, 10)) {
  const current = (data?.currentCommitments || []).filter(
    row => row.source === 'personal' && row.lifecycle === 'current',
  );
  if (current.length > 1) return null;
  if (current.length === 1) return current[0].endDate || null;
  if (data?.legacyCurrentMembership) return data.legacyCurrentMembership.endDate || null;
  const paid = (data?.history || []).filter(row =>
    row.membership_source === 'personal' && row.payment_status === 'paid'
    && ['active', 'paid', 'expired'].includes(row.status)
    && (!row.term_start_date || row.term_start_date <= today),
  ).sort((a, b) => String(b.term_end_date || '').localeCompare(String(a.term_end_date || '')));
  return paid[0]?.term_end_date || null;
}

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
  const validDate = typeof expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expiry)
    && Number.isFinite(Date.parse(expiry));
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
