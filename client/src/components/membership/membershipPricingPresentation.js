function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function finiteAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function isDynamicMembershipPrice(record) {
  if (record?.monthly_price) return true;
  const policy = firstPresent(
    record?.collectionPolicy?.pricing_policy,
    record?.collection_policy?.pricing_policy,
    record?.commitment_snapshot?.collection_policy?.pricing_policy,
    record?.metadata?.dd?.collection_policy?.pricing_policy,
  );
  return String(policy || '').toLowerCase() === 'dynamic';
}

export function formatMembershipMoney(value, currency = 'GBP') {
  const amount = finiteAmount(value);
  if (amount === null) return 'Uncommitted';
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: currency || 'GBP',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || ''} ${amount.toFixed(2)}`.trim();
  }
}

export function formatMembershipPriceDate(value) {
  if (!value) return null;
  const day = String(value).slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function monthlyPrice(record, dynamic, fallbackCurrency) {
  if (!dynamic) return null;
  const supplied = record?.monthly_price;
  let state = supplied?.state;
  let amount = supplied?.amount;
  let currency = supplied?.currency || fallbackCurrency;
  let date = supplied?.date;

  const formattedDate = formatMembershipPriceDate(date);
  const formattedAmount = finiteAmount(amount) === null
    ? null
    : formatMembershipMoney(amount, currency);
  if (state === 'provider_scheduled' && formattedAmount) {
    return {
      state,
      amount: formattedAmount,
      label: formattedDate
        ? `Scheduled collection for ${formattedDate}`
        : 'Scheduled collection',
    };
  }
  if (state === 'calculated' && formattedAmount) {
    return {
      state,
      amount: formattedAmount,
      label: formattedDate
        ? `Variable estimate for ${formattedDate} (not confirmed)`
        : 'Variable estimate (not confirmed)',
    };
  }
  return {
    state: 'unavailable',
    amount: null,
    label: 'Variable monthly price unavailable',
  };
}

export function getMembershipPricingPresentation(record) {
  const snapshotAmounts = record?.commitment_snapshot?.amounts || {};
  const currency = firstPresent(
    record?.monthly_price?.currency,
    record?.currency,
    snapshotAmounts.currency,
    'GBP',
  );
  const dynamic = isDynamicMembershipPrice(record);
  const net = finiteAmount(firstPresent(
    record?.final_cost,
    record?.agreedNetPrice,
    snapshotAmounts.final_cost,
  ));
  const explicitGross = finiteAmount(firstPresent(
    record?.total_with_vat,
    record?.agreedPrice,
    snapshotAmounts.total_with_vat,
  ));
  const vat = finiteAmount(record?.vat_amount);
  const vatRate = finiteAmount(firstPresent(record?.vat_rate, record?.vat_rate_percent));
  const derivedVat = vat ?? (net !== null && vatRate !== null ? net * (vatRate / 100) : null);
  const gross = explicitGross ?? (!dynamic && net !== null
    ? net + (derivedVat ?? 0)
    : null);
  const agreed = finiteAmount(firstPresent(
    record?.total_with_vat,
    record?.final_cost,
    record?.agreedPrice,
    snapshotAmounts.total_with_vat,
    snapshotAmounts.final_cost,
  ));

  return {
    dynamic,
    currency,
    agreed: { amount: agreed, text: formatMembershipMoney(agreed, currency) },
    net: { amount: net, text: formatMembershipMoney(net, currency) },
    vat: { amount: derivedVat, text: formatMembershipMoney(derivedVat, currency) },
    gross: { amount: gross, text: formatMembershipMoney(gross, currency) },
    monthly: monthlyPrice(record, dynamic, currency),
  };
}
