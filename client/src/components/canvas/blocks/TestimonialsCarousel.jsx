import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { testimonialCountForWidth } from '@/lib/testimonialsCarousel';

export default function TestimonialsCarousel({ settings, children: cards, asEditor = false }) {
  const root = useRef(null);
  const viewport = useRef(null);
  const touch = useRef(null);
  const [width, setWidth] = useState(0);
  const [page, setPage] = useState(0);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [hidden, setHidden] = useState(false);
  const count = testimonialCountForWidth(settings, width);
  const pages = Math.max(1, Math.ceil(cards.length / count));
  const current = Math.min(page, pages - 1);
  const active = !asEditor && pages > 1;
  const move = (delta) => setPage((p) => {
    const next = Math.min(p, pages - 1) + delta;
    return settings.loop ? (next + pages) % pages : Math.max(0, Math.min(pages - 1, next));
  });
  useLayoutEffect(() => {
    const read = () => setWidth(root.current?.clientWidth || 0);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => setPage((p) => Math.min(p, pages - 1)), [pages]);
  useLayoutEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 0;
  }, [current, count]);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = () => setReduced(query.matches);
    const visibility = () => setHidden(document.hidden);
    read();
    visibility();
    query.addEventListener('change', read);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      query.removeEventListener('change', read);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  const playing = active && settings.autoplaySeconds > 0 && !reduced && !hidden && !paused && !focus
    && !(settings.pauseOnHover && hover) && (settings.loop || current < pages - 1);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => setPage((p) => (p + 1) % pages), settings.autoplaySeconds * 1000);
    return () => clearTimeout(timer);
  }, [playing, current, pages, settings.autoplaySeconds]);
  const buttonStyle = { minWidth: 32, minHeight: 32, border: '1px solid #94a3b8', borderRadius: 4, background: '#fff', color: '#0f172a' };
  return (
    <div ref={root} role="region" aria-roledescription="carousel" aria-label="Testimonials"
      data-testid="testimonials-carousel" data-per-page={count} data-page={current + 1}
      tabIndex={active ? 0 : undefined}
      style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setFocus(true)}
      onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocus(false); }}
      onKeyDown={(e) => {
        if (!active || e.altKey || e.ctrlKey || e.metaKey) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault(); move(e.key === 'ArrowRight' ? 1 : -1);
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault(); setPage(e.key === 'Home' ? 0 : pages - 1);
        }
      }}
      onTouchStart={(e) => { touch.current = active ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }}
      onTouchCancel={() => { touch.current = null; }}
      onTouchEnd={(e) => {
        const start = touch.current;
        touch.current = null;
        if (!start || !active) return;
        const dx = e.changedTouches[0].clientX - start.x;
        const dy = e.changedTouches[0].clientY - start.y;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) move(dx < 0 ? 1 : -1);
      }}>
      {/* Vertical scrolling is intentional for authored fixed-height frames:
          long quotes remain readable and the controls never get clipped. */}
      <div ref={viewport} data-testid="testimonials-quote-viewport" style={{ flex: '1 1 auto', minHeight: 0, overflowX: 'hidden', overflowY: 'auto', touchAction: 'pan-y' }}>
        <div style={{ display: 'flex', alignItems: 'stretch', transform: `translateX(-${current * 100}%)`, transition: reduced || asEditor ? 'none' : `transform ${settings.transitionMs}ms ease` }}>
          {Array.from({ length: pages }, (_, index) => (
            <div key={index} role="group" aria-roledescription="slide" aria-label={`Page ${index + 1} of ${pages}`}
              aria-hidden={index !== current}
              style={{ flex: '0 0 100%', minWidth: 0, display: 'grid', gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`, gap: 12, alignContent: 'start' }}>
              {cards.slice(index * count, (index + 1) * count)}
            </div>
          ))}
        </div>
      </div>
      {pages > 1 && (
        <div aria-label="Testimonial navigation" style={{ flexShrink: 0, minHeight: 0, maxHeight: '40%', boxSizing: 'border-box', overflowY: 'auto', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '6px 2px' }}>
          {settings.arrows && <button type="button" style={buttonStyle} disabled={!active || (!settings.loop && current === 0)} aria-label="Previous testimonials" onClick={() => move(-1)}>‹</button>}
          {settings.dots && Array.from({ length: pages }, (_, index) => (
            <button type="button" key={index} style={buttonStyle} disabled={!active} aria-label={`Go to testimonials page ${index + 1}`} aria-current={index === current ? 'page' : undefined} onClick={() => setPage(index)}>{index === current ? '●' : '○'}</button>
          ))}
          {settings.arrows && <button type="button" style={buttonStyle} disabled={!active || (!settings.loop && current === pages - 1)} aria-label="Next testimonials" onClick={() => move(1)}>›</button>}
          {settings.autoplaySeconds > 0 && !asEditor && !reduced && <button type="button" style={buttonStyle} onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Resume testimonial autoplay' : 'Pause testimonial autoplay'}>{paused ? 'Play' : 'Pause'}</button>}
        </div>
      )}
      <span className="sr-only" aria-live={playing ? 'off' : 'polite'}>Page {current + 1} of {pages}</span>
    </div>
  );
}
