// Discovery aliases only: values remain IANA zones, never fixed offsets.
export function timezoneDiscoveryKey(timezone) {
  return /^Asia\/(?:Kolkata|Calcutta)$/i.test(timezone) ? 'Asia/Kolkata' : timezone;
}

export function uniqueDiscoveryTimezones(timezones) {
  const seen = new Set();
  return timezones.filter(timezone => {
    const key = timezoneDiscoveryKey(timezone);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function familiarTimezoneName(timezone) {
  switch (timezoneDiscoveryKey(timezone)) {
    case 'Africa/Nairobi': return 'Nairobi — East Africa Time (EAT)';
    case 'Asia/Kolkata': return 'Kolkata / Calcutta — India Standard Time (IST)';
    default: return '';
  }
}

export function timezoneSearchText(timezone, city, abbreviation = '', offset = '') {
  const aliases = timezoneDiscoveryKey(timezone) === 'Asia/Kolkata'
    ? 'Asia/Kolkata Asia/Calcutta' : '';
  return `${timezone} ${city} ${abbreviation} ${offset} ${familiarTimezoneName(timezone)} ${aliases}`
    .toLowerCase().replace(/_/g, ' ').replace(/\s+/g, '');
}
