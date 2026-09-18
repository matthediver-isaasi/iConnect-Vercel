import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export default function NavigationRoleState({ status, error, onRetry }) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    setSlow(false);
    if (status !== 'loading') return undefined;
    const timer = setTimeout(() => setSlow(true), 10000);
    return () => clearTimeout(timer);
  }, [status]);

  if (status === 'ready') return null;

  if (status === 'loading' && !slow) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-label="Loading navigation">
        <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-3 py-8 text-center" role="alert" data-testid="navigation-unavailable">
      <p className="text-sm font-medium text-slate-700">Navigation unavailable</p>
      <p className="mt-1 text-xs text-slate-500">
        {status === 'loading'
          ? 'This is taking longer than expected.'
          : (error?.message || error || 'Your navigation role is not available.')}
      </p>
      <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}