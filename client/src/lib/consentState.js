const denied = Object.freeze({ necessary: true, functional: false, analytics: false, marketing: false });
let snapshot = { ready: false, hasActed: false, categories: denied };
const listeners = new Set();
let actions = {};
export const consentState = {
  getSnapshot: () => snapshot,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  publish(next, controls = actions) {
    snapshot = next; actions = controls;
    listeners.forEach(fn => fn());
  },
  deny() { this.publish({ready:false,hasActed:false,categories:denied}, {}); },
  act(name) { actions[name]?.(); },
};
