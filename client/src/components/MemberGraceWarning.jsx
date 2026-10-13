import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';

export default function MemberGraceWarning({ memberId, enabled }) {
  const { data, error } = useQuery({
    queryKey: ['member-membership', memberId],
    enabled: enabled && !!memberId,
    queryFn: async () => {
      const response = await fetch(`/api/membership/member-membership?memberId=${encodeURIComponent(memberId)}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Membership status unavailable');
      return response.json();
    },
    refetchInterval: 60000,
  });
  const warning = data?.graceWarning;
  if (error || data?.graceWarningUnavailable) {
    return <p role="status" className="mb-4 text-sm text-amber-800">Membership renewal status could not be checked. Please check the Membership tab.</p>;
  }
  if (!warning) return null;
  const date = warning.endsOn.split('-').reverse().join('/');
  return (
    <section role="alert" data-testid="member-grace-warning"
      className={`mb-6 flex gap-3 rounded-lg border-l-4 p-4 ${warning.expired
        ? 'border-red-600 bg-red-50 text-red-950' : 'border-amber-500 bg-amber-50 text-amber-950'}`}>
      <AlertTriangle className="h-6 w-6 shrink-0" aria-hidden="true" />
      <div>
        <h2 className="font-semibold">{warning.expired
          ? 'Grace period expired — membership has not been renewed'
          : 'Individual membership is in its grace period'}</h2>
        <p className="mt-1 text-sm">
          {warning.days != null && `${warning.days} ${warning.days === 1 ? 'day' : 'days'} since grace began. `}
          Grace {warning.expired ? 'ended' : 'ends'} on {date}.
        </p>
        <p className="mt-1 text-sm">{warning.reason}</p>
        <p className="mt-2 text-sm font-medium">Review membership and payment details before taking further action.</p>
      </div>
    </section>
  );
}
