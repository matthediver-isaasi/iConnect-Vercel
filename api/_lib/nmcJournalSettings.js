const TABLE = 'nmc_journal_settings';
const legacyOnlineClasses = ['Associate', 'Full', 'Full junior', 'Trainee', 'Student', 'Overseas Full', 'Overseas Full junior', 'Honorary', 'Retired', 'Former', 'Department contact', 'Patient representative', 'LMIC Full', 'LMIC Full junior', 'Overseas associate', 'CPD Guest'];
const legacyPrintedClasses = ['Full with NMC', 'Full junior with NMC', 'Overseas Full with NMC', 'Overseas Full junior with NMC'];

export function nmcClassOptions(options) {
  if (!Array.isArray(options) || !options.length) throw new Error('Class definitions unavailable');
  const result = options.map(option => typeof option === 'string'
    ? { value: option, label: option } : { value: option?.value, label: option?.label || option?.value });
  if (result.some(o => typeof o.value !== 'string' || !o.value || typeof o.label !== 'string')
    || new Set(result.map(o => o.value)).size !== result.length) throw new Error('Class definitions ambiguous');
  return result;
}

export function defaultNmcJournalSettings(options) {
  const matches = (option, names) => names.includes(option.value) || names.includes(option.label);
  const printedClasses = options.filter(o => matches(o, legacyPrintedClasses)).map(o => o.value);
  return {
    printedClasses,
    onlineClasses: options.filter(o => !printedClasses.includes(o.value) && matches(o, legacyOnlineClasses)).map(o => o.value),
    revision: 0,
  };
}

function settingsError(message, status = 400) {
  return Object.assign(new Error(message), { status, publicMessage: message });
}

export function validateNmcJournalSettings(input, options, current) {
  if (!input || Object.keys(input).some(k => !['printedClasses', 'onlineClasses', 'revision'].includes(k))
    || !Number.isSafeInteger(input.revision) || input.revision < 0) throw settingsError('Invalid journal settings');
  const allowed = new Set(options.map(o => o.value));
  for (const key of ['printedClasses', 'onlineClasses']) {
    const values = input[key];
    if (!Array.isArray(values) || values.length > 1000 || values.some(v => typeof v !== 'string' || !v || v.length > 500)
      || new Set(values).size !== values.length) throw settingsError('Choose valid, distinct member classes');
    // Preserve retired saved choices, but never authorize newly invented classes.
    if (values.some(v => !allowed.has(v) && !current[key].includes(v))) throw settingsError('A selected member class no longer exists. Reload the settings.');
  }
  if (input.printedClasses.some(v => input.onlineClasses.includes(v))) throw settingsError('A class cannot receive both printed and online-only delivery');
  if (input.revision !== current.revision) throw settingsError('Journal settings changed. Reload before saving again.', 409);
  return { printedClasses: [...input.printedClasses], onlineClasses: [...input.onlineClasses], revision: input.revision };
}

export async function loadNmcJournalSettings(db, tenantId) {
  const { data, error } = await db.from(TABLE).select('printed_classes,online_classes,revision').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw new Error('Journal settings could not be loaded');
  if (!data) return null;
  const settings = { printedClasses: data.printed_classes, onlineClasses: data.online_classes, revision: data.revision };
  if (!Number.isSafeInteger(settings.revision) || settings.revision < 1
    || !['printedClasses', 'onlineClasses'].every(k => Array.isArray(settings[k]) && settings[k].every(v => typeof v === 'string'))
    || settings.printedClasses.some(v => settings.onlineClasses.includes(v))) throw new Error('Invalid stored journal settings');
  return settings;
}

export async function saveNmcJournalSettings(db, tenantId, input, options) {
  const current = await loadNmcJournalSettings(db, tenantId) || defaultNmcJournalSettings(options);
  const settings = validateNmcJournalSettings(input, options, current);
  const payload = { printed_classes: settings.printedClasses, online_classes: settings.onlineClasses,
    revision: current.revision + 1, updated_at: new Date().toISOString() };
  const query = current.revision === 0
    ? db.from(TABLE).insert({ tenant_id: tenantId, ...payload })
    : db.from(TABLE).update(payload).eq('tenant_id', tenantId).eq('revision', current.revision);
  const { data, error } = await query.select('revision').maybeSingle();
  if (error?.code === '23505' || (!error && !data)) throw settingsError('Journal settings changed. Reload before saving again.', 409);
  if (error) throw new Error('Journal settings could not be saved');
  return { ...settings, revision: data.revision };
}
