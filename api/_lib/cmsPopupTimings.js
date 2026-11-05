import { performance } from 'node:perf_hooks';

export function popupTimings(res) {
  const started = performance.now();
  const durations = new Map();
  const json = res.json;
  res.json = function (...args) {
    const values = [...durations, ['total', performance.now() - started]];
    res.setHeader('Server-Timing', values.map(([name, ms]) => `${name};dur=${ms.toFixed(2)}`).join(', '));
    return json.apply(this, args);
  };
  return async (name, work) => {
    const start = performance.now();
    try { return await work(); }
    finally { durations.set(name, (durations.get(name) || 0) + performance.now() - start); }
  };
}
