// Registry of available demo tenant definitions.
//
// The platform-admin console and API list/manage demo tenants from this
// registry. Adding a future demo tenant = add its definition module and one
// entry here.

import aesp from './aesp/definition.mjs';

const DEFINITIONS = [aesp];

export function listDemoDefinitions() {
  return DEFINITIONS;
}

export function getDemoDefinition(key) {
  return DEFINITIONS.find((d) => d.key === key) || null;
}
