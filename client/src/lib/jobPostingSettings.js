export const DEFAULT_JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship'];
export const DEFAULT_JOB_HOURS = ['Full-time', 'Part-time', 'Flexible'];
export const DEFAULT_JOB_POSTING_PRICE = 50;

function parseJsonArray(value, fallback) {
  if (value == null || value === '') return fallback;

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return fallback;

    const options = parsed
      .filter((option) => typeof option === 'string')
      .map((option) => option.trim())
      .filter(Boolean);

    return options.length > 0 ? [...new Set(options)] : fallback;
  } catch {
    return fallback;
  }
}

export function parseJobPostingOptions(setting, fallback) {
  return parseJsonArray(setting?.setting_value, fallback);
}

export function parseJobPostingPrice(setting, fallback = DEFAULT_JOB_POSTING_PRICE) {
  if (!setting || setting.setting_value == null || setting.setting_value === '') {
    return fallback;
  }

  const parsed = Number(setting.setting_value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveJobPostingSettings(settings = []) {
  const rows = Array.isArray(settings) ? settings : [];
  const byKey = new Map(rows.map((setting) => [setting?.setting_key, setting]));

  return {
    jobTypes: parseJobPostingOptions(byKey.get('job_types'), DEFAULT_JOB_TYPES),
    hours: parseJobPostingOptions(byKey.get('job_hours'), DEFAULT_JOB_HOURS),
    price: parseJobPostingPrice(byKey.get('job_posting_price')),
  };
}