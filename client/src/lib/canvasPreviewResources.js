// Resource settling is best-effort, not preview authorization or page identity.
// Offscreen lazy images may never load without scrolling. Slow images/fonts
// must not consume the editor's entire readiness-handshake deadline.
export function waitForCanvasPreviewResources(doc, { signal, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    let timer;
    const cleanups = [];
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanups.forEach((cleanup) => cleanup());
      resolve();
    };
    if (signal?.aborted) { finish(); return; }
    signal?.addEventListener('abort', finish, { once: true });
    cleanups.push(() => signal?.removeEventListener('abort', finish));
    timer = setTimeout(finish, timeoutMs);
    const pending = [];
    try {
      for (const img of Array.from(doc.images || [])) {
        if (img.complete || img.loading === 'lazy') continue;
        pending.push(new Promise((done) => {
          let listening = true;
          const loaded = () => { cleanup(); done(); };
          const cleanup = () => {
            if (!listening) return;
            listening = false;
            img.removeEventListener('load', loaded);
            img.removeEventListener('error', loaded);
          };
          img.addEventListener('load', loaded, { once: true });
          img.addEventListener('error', loaded, { once: true });
          cleanups.push(() => { cleanup(); done(); });
          // Close the cache-hit race between checking complete and listening.
          if (img.complete) loaded();
        }));
      }
      if (doc.fonts?.ready) pending.push(Promise.resolve(doc.fonts.ready).catch(() => {}));
    } catch { /* unavailable resource APIs must not prevent auditing the DOM */ }
    Promise.all(pending).then(finish, finish);
  });
}
