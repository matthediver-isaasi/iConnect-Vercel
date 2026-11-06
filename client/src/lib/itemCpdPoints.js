export const ITEM_CPD_POINTS_ERROR = 'Enter CPD points from 0 to 10000 with no more than 6 decimal places.';

export function validateItemCpdPoints(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(text)
    || !Number.isFinite(Number(text)) || Number(text) > 10000) {
    return ITEM_CPD_POINTS_ERROR;
  }
  return null;
}

export function serializeItemCpdPoints(value) {
  const error = validateItemCpdPoints(value);
  if (error) throw new Error(error);
  return value == null || String(value).trim() === '' ? null : Number(value);
}

export function validateTrainingAgendaCpdPoints(line) {
  const error = validateItemCpdPoints(line.cpd_points);
  if (error) return error;
  if (Number(line.cpd_points) > 0 && line.end_date && line.end_date !== line.start_date) {
    return 'For daily CPD, use separate agenda lines per day. An agenda line with positive CPD points must end on its start date (or leave the end date blank).';
  }
  return null;
}
