// Retired for stale clients as well as the current report. No provider imports.
export async function handleReconcileBookingCredits(req, res) {
  return res.status(410).json({
    code: 'CREDIT_DISCOVERY_RETIRED',
    error: 'Credits now use local iConnect records. Reload the report.',
  });
}

export default handleReconcileBookingCredits;
