import React from 'react';
import { useBiographyHelperSettings } from '@/hooks/useBiographyHelperSettings';
import { DEFAULT_BIOGRAPHY_HELPER_TEXT } from '../../../shared/biographyHelperText.js';

export default function BiographyHelperText({ tenantId }) {
  const query = useBiographyHelperSettings(tenantId);
  return <>
    {query.isFetching && !query.data && <p role="status" className="text-xs text-slate-500">Loading biography helper text…</p>}
    <p className="text-xs text-slate-500" data-testid="biography-helper-text">{(!query.error && query.data?.helperText) || DEFAULT_BIOGRAPHY_HELPER_TEXT}</p>
    {query.error && <div role="alert" className="text-xs text-red-700">
      <p>Unable to load biography helper text. The default explanation is shown.</p>
      <button type="button" className="underline" onClick={() => query.refetch()}>Retry loading biography helper text</button>
    </div>}
  </>;
}
