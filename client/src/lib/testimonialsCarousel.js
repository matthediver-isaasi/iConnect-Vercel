const bounded = (value, fallback, min, max) => {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

// Absence is deliberate: loading old designs must not opt them into pagination.
export function normalizeTestimonialsCarousel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    perPage: {
      desktop: bounded(value.perPage?.desktop, 3, 1, 12),
      tablet: bounded(value.perPage?.tablet, 2, 1, 12),
      mobile: bounded(value.perPage?.mobile, 1, 1, 12),
    },
    arrows: typeof value.arrows === 'boolean' ? value.arrows : true,
    dots: typeof value.dots === 'boolean' ? value.dots : true,
    loop: typeof value.loop === 'boolean' ? value.loop : true,
    pauseOnHover: typeof value.pauseOnHover === 'boolean' ? value.pauseOnHover : true,
    autoplaySeconds: bounded(value.autoplaySeconds, 0, 0, 300),
    transitionMs: bounded(value.transitionMs, 300, 0, 3000),
  };
}

export function testimonialCountForWidth(settings, width) {
  return settings.perPage[width < 640 ? 'mobile' : width < 1024 ? 'tablet' : 'desktop'];
}
