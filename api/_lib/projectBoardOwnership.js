// Keep database conflicts explicit: a blocked ownership change is not a server
// error, and missing migration support must never fall back to unsafe writes.
export function boardMembershipError(error) {
  if (['PGRST202', '42883'].includes(error?.code)) {
    return { status: 503, message: 'Board ownership protection requires the database update. Please retry later.' };
  }
  const status = { PT409: 409, '42501': 403, P0002: 404, '23505': 400, '22023': 400, '22P02': 400 }[error?.code];
  return status
    ? { status, message: error.message }
    : { status: 500, message: 'Failed to update board membership' };
}
