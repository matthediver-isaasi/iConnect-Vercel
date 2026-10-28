import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { isTbcHash } from '@/lib/tbcEventsBanner';

// Router navigation and native hash changes both work. Do not mark a pending
// deep link handled until asynchronous event/settings data has rendered a target.
export function useTbcSectionNavigation({ anchor, visible, loading }) {
  const location = useLocation();
  const [nativeHash, setNativeHash] = useState(() => window.location.hash);
  const handled = useRef(null);
  useEffect(() => {
    const update = () => setNativeHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => { setNativeHash(location.hash); }, [location.hash, location.key]);
  useEffect(() => {
    const navigation = `${location.key}:${nativeHash}`;
    if (!isTbcHash(nativeHash, anchor)) {
      handled.current = null;
      return;
    }
    if (loading || !visible || handled.current === navigation) return;
    const frame = requestAnimationFrame(() => {
      const node = document.getElementById(anchor);
      if (!node) return;
      node.scrollIntoView({ behavior: 'auto', block: 'start' });
      handled.current = navigation;
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor, visible, loading, nativeHash, location.key]);
}
