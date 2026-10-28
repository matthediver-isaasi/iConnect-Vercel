import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

// Query-only router navigation otherwise drops a pending section deep link.
export function useEventFilterParams() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const update = useCallback(mutate => {
    const next = new URLSearchParams(location.search);
    mutate(next);
    const search = next.size ? `?${next.toString()}` : '';
    if (search === location.search) return;
    navigate({ pathname: location.pathname, search, hash: location.hash },
      { replace: true, state: location.state });
  }, [location.pathname, location.search, location.hash, location.state, navigate]);
  return [searchParams, update];
}
