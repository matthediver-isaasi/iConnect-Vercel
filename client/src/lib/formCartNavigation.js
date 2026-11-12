export function cartViewTarget({ fields = [], pages = [], allPages = [], layout } = {}) {
  for (const [step, field] of fields.entries()) {
    if (field.type !== 'sales_cart_view') continue;
    if (field.page_id && allPages.some(p => p.id === field.page_id)
      && !pages.some(p => p.id === field.page_id)) continue;
    const page = pages.length ? pages.findIndex((p, index) => p.fields
      ? p.fields.some(f => f.id === field.id)
      : field.page_id === p.id || (!field.page_id && index === 0)) : 0;
    // Never jump to a hidden page, including in swipe layout.
    if (page < 0) continue;
    return { page, step, swipe: layout === 'card_swipe' };
  }
  return null;
}

export function openCartView(navigation, target, root) {
  if (target.swipe) navigation.setStep(target.step);
  else navigation.setPage(target.page);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!root?.isConnected) return;
    const view = root.querySelector('[data-form-cart-view]');
    view?.focus({ preventScroll: true });
    view?.scrollIntoView({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }));
}
