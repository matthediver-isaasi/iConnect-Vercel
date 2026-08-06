// Render a Lucide icon by its stored (kebab or Pascal) name, lazy-loading it
// from the full catalog (lib/lucideCatalog). While loading — or when the name
// is empty/unknown — renders the `fallback` component instead, so consumers
// like the event-card mini agenda always show *an* icon.
import { useEffect, useState } from 'react';
import { getCachedLucideIcon, loadLucideIcon } from '@/lib/lucideCatalog';

export default function DynamicLucideIcon({ name, fallback: Fallback = null, className, ...rest }) {
  const [, force] = useState(0);
  const Cmp = name ? getCachedLucideIcon(name) : null;

  useEffect(() => {
    if (!name || Cmp) return;
    let cancelled = false;
    loadLucideIcon(name)
      .then((loaded) => { if (!cancelled && loaded) force((n) => n + 1); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [name, Cmp]);

  if (Cmp) return <Cmp className={className} {...rest} />;
  return Fallback ? <Fallback className={className} {...rest} /> : null;
}
