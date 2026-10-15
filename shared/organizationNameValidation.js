// PATCH/PUT may omit name; supplying it explicitly must never clear it.
export function organizationNameError(body) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'name')) return null;
  return typeof body.name === 'string' && body.name.trim().length > 0
    ? null : 'Organisation name is required';
}
