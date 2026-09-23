import { createHandler as createDataHandler } from './data.js';

export function createHandler(overrides = {}) {
  return createDataHandler({ ...overrides, refresh: true });
}

export default async function handler(req, res) {
  return createHandler()(req, res);
}