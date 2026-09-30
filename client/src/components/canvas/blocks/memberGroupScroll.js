// Scroll only the actual scroll owner, not every ancestor (notably editor
// chrome). Use an instant move so resize/reflow cannot fight an animation.
export function scrollMemberGroupToTop(element) {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  let owner = element.parentElement;
  while (owner && owner !== doc.body && owner !== doc.documentElement) {
    if (/(auto|scroll|overlay)/.test(win.getComputedStyle(owner).overflowY)
      && owner.scrollHeight > owner.clientHeight) break;
    owner = owner.parentElement;
  }
  const nested = owner && owner !== doc.body && owner !== doc.documentElement;
  const edge = nested ? owner.getBoundingClientRect().top + owner.clientTop : 0;
  let offset = 0;
  doc.querySelectorAll('header, nav, [data-canvas-sticky]').forEach((header) => {
    if (element.contains(header) || (nested && !owner.contains(header))) return;
    const position = win.getComputedStyle(header).position;
    const rect = header.getBoundingClientRect();
    if ((position === 'fixed' || position === 'sticky') && rect.top <= edge + 1 && rect.bottom > edge) {
      offset = Math.max(offset, rect.bottom - edge);
    }
  });
  const scroller = nested ? owner : win;
  const top = (nested ? owner.scrollTop : win.scrollY)
    + element.getBoundingClientRect().top - edge - offset - 8;
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
}