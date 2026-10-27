export class AmendmentCalculationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AmendmentCalculationError';
    this.code = 'amendment_evidence_required';
    this.status = 422;
  }
}
const fail = message => { throw new AmendmentCalculationError(message); };

export function amendmentDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('An exact calendar date is required.');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== value) fail('Invalid calendar date.');
  return ms / 86400000;
}
export function amendmentTermDays(startDate, renewalDate, effectiveDate, {allowTermEnd=false}={}) {
  const start = amendmentDay(startDate), renewal = amendmentDay(renewalDate), effective = amendmentDay(effectiveDate);
  const totalDays = renewal - start, remainingDays = renewal - effective;
  if (totalDays <= 0 || remainingDays < 0 || (!allowTermEnd && remainingDays === 0) || remainingDays > totalDays) fail('The effective date must be within the current term.');
  return {totalDays,remainingDays,elapsedDays:totalDays-remainingDays};
}
function minor(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('Nonnegative integer minor-unit amounts are required.');
  return value;
}
export function amendmentSafeMinor(value) {
  if (!Number.isSafeInteger(value)) fail('Amount exceeds safe minor-unit bounds.');
  return value;
}
export function amendmentMoneyParts(value) {
  if (!value || typeof value !== 'object') fail('Net and tax evidence is required.');
  const netMinor=minor(value.netMinor),vatMinor=minor(value.vatMinor);
  const grossMinor=amendmentSafeMinor(netMinor+vatMinor);
  if (value.grossMinor !== undefined && value.grossMinor !== grossMinor) fail('Net and tax do not match the gross amount.');
  return {netMinor,vatMinor,grossMinor};
}
export function prorateAmendmentMoney(value,numerator,denominator) {
  const parts=amendmentMoneyParts(value);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
    || numerator<0 || denominator<=0 || numerator>denominator) fail('Invalid proration period.');
  const round=amount=>Number((BigInt(amount)*BigInt(numerator)*2n+BigInt(denominator))/(BigInt(denominator)*2n));
  return amendmentMoneyParts({netMinor:round(parts.netMinor),vatMinor:round(parts.vatMinor)});
}
