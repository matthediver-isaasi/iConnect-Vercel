// Imported by the preview itself: axe must be created in the audited realm.
export function installPreviewAudit(identity) {
  const doc = document;
  let active = true;
  let running = false;
  const runner = {
    ...identity, document: doc,
    async run() {
      if (!active || running) throw new Error('Preview changed or an audit is already running. Rerun the audit.');
      running = true;
      try {
        const axe = (await import('axe-core')).default;
        if (!active || document !== doc) throw new Error('Preview replaced. Rerun the audit.');
        const result = await axe.run(doc, {
          runOnly: ['wcag2a', 'wcag2aa', 'best-practice'], resultTypes: ['violations'],
        });
        if (!active || document !== doc) throw new Error('Preview changed during the audit. Rerun the audit.');
        return result;
      } finally { running = false; }
    },
  };
  window.__canvasPreviewAudit = runner;
  return () => {
    active = false;
    if (window.__canvasPreviewAudit === runner) delete window.__canvasPreviewAudit;
  };
}

export function assertPreviewIdentity(iframe, signal, expected) {
  const doc = iframe?.contentDocument;
  const runner = iframe?.contentWindow?.__canvasPreviewAudit;
  if (!doc || !signal || signal.document !== doc || runner?.document !== doc
    || signal.runner !== runner
    || runner.pageId !== expected.pageId || runner.nonce !== expected.nonce
    || runner.view !== expected.view) {
    throw new Error('The expected preview is not ready or has changed. Refresh and rerun the audit.');
  }
  return { doc, runner };
}

// Axe's outer path traverses frames; an array at a path step traverses
// shadow roots. Never discard path segments or choose an ambiguous match.
export function resolveAuditTarget(doc, target) {
  try {
    const path = typeof target === 'string' ? [target] : target;
    if (!Array.isArray(path) || !path.length) return null;
    let root = doc, element;
    for (let i = 0; i < path.length; i++) {
      const selectors = Array.isArray(path[i]) ? path[i] : [path[i]];
      for (let j = 0; j < selectors.length; j++) {
        if (typeof selectors[j] !== 'string') return null;
        const matches = root.querySelectorAll(selectors[j]);
        if (matches.length !== 1) return null;
        element = matches[0];
        if (j < selectors.length - 1) {
          root = element.shadowRoot;
          if (!root) return null;
        }
      }
      if (i < path.length - 1) {
        root = element.contentDocument;
        if (!root) return null;
      }
    }
    return element;
  } catch { return null; }
}

export function editableBlockMap(design) {
  const map = new Map();
  const visit = b => {
    if (b?.id) map.set(b.id, b.name || b.type || b.id);
    (b?.children || []).forEach(visit);
  };
  (design?.root?.children || []).forEach(visit);
  (design?.root?.sections || []).forEach(s => (s.children || []).forEach(visit));
  return map;
}

// Do not duplicate an entire page (including shell content) in every
// document-level finding. Two independent hashes plus length fence reuse.
function fingerprint(el) {
  if (!el) return null;
  const text = el.outerHTML;
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

export function mapAuditResults(results, doc, blocks, view) {
  return (results.violations || []).flatMap(v => v.nodes.map(n => {
    const el = resolveAuditTarget(doc, n.target);
    let blockId = null;
    for (let ancestor = el; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode?.().host) {
      const id = ancestor.getAttribute?.('data-block-id');
      if (blocks.has(id)) { blockId = id; break; }
    }
    const scope = !el ? 'unresolved' : blockId ? 'block'
      : (el === doc.documentElement || el === doc.body || el === doc.head) ? 'document' : 'element';
    return {
      evidenceVersion: 1, blockId, blockName: blocks.get(blockId) || null,
      scope, rule: `axe:${v.id}`,
      severity: ['critical', 'serious'].includes(v.impact) ? 'error' : v.impact === 'moderate' ? 'warning' : 'info',
      message: v.help || v.description || v.id,
      target: n.target, selector: n.target, html: n.html,
      fingerprint: fingerprint(el),
      elementLabel: el ? `${el.localName}${el.id ? `#${el.id}` : ''} ${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 160)}` : n.html,
      failureSummary: n.failureSummary,
      checks: ['any', 'all', 'none'].flatMap(group => (n[group] || []).map(c => ({
        group, id: c.id, message: c.message, data: c.data,
      }))),
      helpUrl: v.helpUrl, view,
    };
  }));
}

export function verifiedAuditTarget(doc, issue) {
  const el = resolveAuditTarget(doc, issue.target);
  if (!issue.evidenceVersion || !issue.fingerprint || !el || fingerprint(el) !== issue.fingerprint) {
    throw new Error('This target is historical, changed, missing or unsupported. Rerun the audit to locate it safely.');
  }
  return el;
}

export function highlightAuditTarget(el) {
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  // Web Animations do not mutate the content or saved inline styles.
  const animation = el.animate([
    { outline: '4px solid #e11d48', outlineOffset: '4px' },
    { outline: '4px solid #e11d48', outlineOffset: '4px' },
  ], { duration: 4000 });
  return () => animation.cancel();
}
