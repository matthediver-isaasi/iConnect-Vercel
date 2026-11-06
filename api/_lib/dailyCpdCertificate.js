// Daily certificate content is derived only from immutable earned-award
// snapshots. Current agenda/session allowances cannot rewrite past credit.
export function dailyCpdCertificate(rows = []) {
  const awards = new Map(rows.filter(row => row.entry_kind === 'event_award').map(row => [row.id, row]));
  if (![...awards.values()].some(row => row.rule_snapshot?.itemCpd)) return null;
  const totals = new Map();
  for (const row of rows) {
    const source = row.entry_kind === 'event_award' ? row : awards.get(row.reversal_of);
    const day = source?.rule_snapshot?.itemCpd?.day;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Number(row.points_value))) {
      throw new Error('The daily CPD award history needs review before a certificate can be issued.');
    }
    const amount = Math.round(Number(row.points_value) * 1e6);
    if (!Number.isSafeInteger(amount)) throw new Error('Invalid daily CPD award amount');
    totals.set(day, (totals.get(day) || 0) + amount);
  }
  const entries = [...totals].sort(([a], [b]) => a.localeCompare(b));
  if (entries.some(([,value]) => value < 0)) throw new Error('Daily CPD corrections require review.');
  const lines = entries.filter(([,value]) => value > 0).map(([day,value]) => {
    const date = new Date(`${day}T12:00:00Z`);
    if (date.toISOString().slice(0,10) !== day) throw new Error('Invalid CPD award date');
    const n = date.getUTCDate();
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({1:'st',2:'nd',3:'rd'}[n % 10] || 'th');
    const weekday = date.toLocaleDateString('en-GB',{weekday:'long',timeZone:'UTC'});
    const month = date.toLocaleDateString('en-GB',{month:'long',timeZone:'UTC'});
    const points = value / 1e6;
    return `${weekday} ${n}${suffix} ${month} ${date.getUTCFullYear()} – ${points} ${points === 1 ? 'point' : 'points'}`;
  });
  return { total: entries.reduce((sum,[,value]) => sum+value,0)/1e6, text: lines.join('\n') };
}
