import { useLayoutEffect, useState } from 'react';
import { calculateFitScale } from '@/lib/cpdCertificateGeometry';

// Measure the scroll viewport, never the scaled page (which would feed its
// dimensions back into fit). Reattach after the async designer has mounted.
export function useCertificateViewport(ref, { ready, mode, zoom, page }) {
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState(480);
  useLayoutEffect(() => {
    const viewport = ref.current;
    if (!ready || !viewport) return undefined;
    let frame;
    const measure = () => {
      const top = viewport.getBoundingClientRect().top;
      setHeight(Math.max(320, window.innerHeight - Math.max(0, top)));
      const css = getComputedStyle(viewport);
      const width = viewport.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      const availableHeight = viewport.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
      if (width > 0 && availableHeight > 0) {
        const next = calculateFitScale(zoom, { width, height: availableHeight }, page);
        setScale(previous => Math.abs(previous - next) < 0.000001 ? previous : next);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    // Ancestor width/height changes include portal navigation and wrapped
    // toolbars, even when the browser window itself hasn't resized.
    for (let node = viewport; node; node = node.parentElement) observer.observe(node);
    measure();
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [ref, ready, mode, zoom, page.width, page.height]);
  return { scale, height };
}