// Installed atomically with the stock-option trigger/receipt migration.
// Missing capability means legacy behavior; operational failures are not readiness.
export async function formBundleStockOptionReady(db) {
  const { data, error } = await db.rpc('form_bundle_stock_option_version');
  if (error) {
    if (['PGRST202', '42883'].includes(error.code)) return false;
    throw error;
  }
  return data === 1;
}
