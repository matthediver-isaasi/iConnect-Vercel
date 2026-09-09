function ordinal(day) {
  const value = Number(day);
  if (!Number.isInteger(value) || value < 1 || value > 28) return null;
  const suffix = value % 10 === 1 && value !== 11
    ? 'st'
    : value % 10 === 2 && value !== 12
      ? 'nd'
      : value % 10 === 3 && value !== 13
        ? 'rd'
        : 'th';
  return `${value}${suffix}`;
}

export function directDebitFirstCollectionText({ firstCollectionRule, collectionDay } = {}) {
  if (firstCollectionRule === 'nominated_day') {
    const day = ordinal(collectionDay);
    if (day) return `On the next applicable ${day} of the month`;
  }
  if (firstCollectionRule === 'anniversary') {
    return 'On the next applicable monthly date matching the day your membership year starts';
  }
  return 'As soon as the mandate permits';
}