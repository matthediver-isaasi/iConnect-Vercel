export function normalizeSubscriberEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function escapeLikeLiteral(value) {
  return String(value).replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function persistUnsubscribeLedger(db, {
  tenantId,
  normalizedEmail,
  unsubscribeType,
  categoryId = null,
  campaignId = null,
  now,
}) {
  let existingQuery = db
    .from('email_unsubscribe')
    .select('id')
    .eq('tenant_id', tenantId)
    .ilike('email', escapeLikeLiteral(normalizedEmail))
    .eq('unsubscribe_type', unsubscribeType);
  existingQuery = categoryId
    ? existingQuery.eq('communication_category_id', categoryId)
    : existingQuery.is('communication_category_id', null);
  const { data: existing, error: existingError } = await existingQuery;
  if (existingError) throw existingError;

  const values = {
    email: normalizedEmail,
    member_id: null,
    campaign_id: campaignId,
    source: 'user',
    unsubscribed_at: now,
  };
  if (existing?.length) {
    const { error: updateError } = await db
      .from('email_unsubscribe')
      .update(values)
      .in('id', existing.map((row) => row.id));
    if (updateError) throw updateError;
    return;
  }

  const { error: insertError } = await db
    .from('email_unsubscribe')
    .insert({
      tenant_id: tenantId,
      ...values,
      unsubscribe_type: unsubscribeType,
      communication_category_id: categoryId,
    });
  if (insertError) throw insertError;
}

async function removeUnsubscribeLedger(db, {
  tenantId,
  normalizedEmail,
  unsubscribeType,
  categoryId = null,
}) {
  let query = db
    .from('email_unsubscribe')
    .delete()
    .eq('tenant_id', tenantId)
    .ilike('email', escapeLikeLiteral(normalizedEmail))
    .eq('unsubscribe_type', unsubscribeType);
  query = categoryId
    ? query.eq('communication_category_id', categoryId)
    : query.is('communication_category_id', null);
  const { error } = await query;
  if (error) throw error;
}

export async function loadExternalSubscriberPreferences(db, { tenantId, email, activeCategories }) {
  const normalizedEmail = normalizeSubscriberEmail(email);
  const [{ data: subscriberRows, error: subscriberError }, { data: unsubscribeRows, error: unsubscribeError }] = await Promise.all([
    db
      .from('email_subscriber')
      .select('id, communication_category_id, opted_out')
      .eq('tenant_id', tenantId)
      .ilike('email', escapeLikeLiteral(normalizedEmail)),
    db
      .from('email_unsubscribe')
      .select('unsubscribe_type, communication_category_id')
      .eq('tenant_id', tenantId)
      .ilike('email', escapeLikeLiteral(normalizedEmail))
      .in('unsubscribe_type', ['all', 'category']),
  ]);
  if (subscriberError) throw subscriberError;
  if (unsubscribeError) throw unsubscribeError;

  const rows = subscriberRows || [];
  const ledgers = unsubscribeRows || [];
  const globalOptOut = ledgers.some((row) => row.unsubscribe_type === 'all');
  const categoryOptOuts = new Set(
    ledgers
      .filter((row) => row.unsubscribe_type === 'category' && row.communication_category_id)
      .map((row) => row.communication_category_id)
  );
  const rowsByCategory = new Map();
  for (const row of rows) {
    if (!row.communication_category_id) continue;
    const existing = rowsByCategory.get(row.communication_category_id) || [];
    existing.push(row);
    rowsByCategory.set(row.communication_category_id, existing);
  }

  const categories = (activeCategories || [])
    .filter((category) => rowsByCategory.has(category.id))
    .map((category) => ({
      ...category,
      isSubscribed: !globalOptOut
        && !categoryOptOuts.has(category.id)
        && rowsByCategory.get(category.id).some((row) => row.opted_out !== true),
    }));

  return { normalizedEmail, categories, optedOutAll: globalOptOut };
}

export async function optOutExternalCategory(db, { tenantId, email, categoryId, campaignId = null }) {
  return setExternalCategorySubscription(db, {
    tenantId,
    email,
    categoryId,
    isSubscribed: false,
    campaignId,
  });
}

export async function setExternalCategorySubscription(db, {
  tenantId,
  email,
  categoryId,
  isSubscribed,
  campaignId = null,
}) {
  const normalizedEmail = normalizeSubscriberEmail(email);
  const now = new Date().toISOString();
  const { data: matchingRows, error: matchError } = await db
    .from('email_subscriber')
    .select('id')
    .eq('tenant_id', tenantId)
    .ilike('email', escapeLikeLiteral(normalizedEmail))
    .eq('communication_category_id', categoryId);
  if (matchError) throw matchError;
  if (!matchingRows?.length) return { found: false };

  const ids = matchingRows.map((row) => row.id);
  const updateValues = isSubscribed
    ? { opted_out: false, opted_out_at: null, updated_at: now }
    : { opted_out: true, opted_out_at: now, updated_at: now };
  const { error: updateError } = await db
    .from('email_subscriber')
    .update(updateValues)
    .in('id', ids);
  if (updateError) throw updateError;

  if (isSubscribed) {
    await removeUnsubscribeLedger(db, {
      tenantId,
      normalizedEmail,
      unsubscribeType: 'category',
      categoryId,
    });
  } else {
    await persistUnsubscribeLedger(db, {
      tenantId,
      normalizedEmail,
      unsubscribeType: 'category',
      categoryId,
      campaignId,
      now,
    });
  }
  return { found: true, isSubscribed };
}

export async function optOutExternalAll(db, {
  tenantId,
  email,
  campaignId = null,
  categoryIds = [],
}) {
  const normalizedEmail = normalizeSubscriberEmail(email);
  const now = new Date().toISOString();
  const { error: updateError } = await db
    .from('email_subscriber')
    .update({ opted_out: true, opted_out_at: now, updated_at: now })
    .eq('tenant_id', tenantId)
    .ilike('email', escapeLikeLiteral(normalizedEmail));
  if (updateError) throw updateError;

  await persistUnsubscribeLedger(db, {
    tenantId,
    normalizedEmail,
    unsubscribeType: 'all',
    campaignId,
    now,
  });
  for (const categoryId of categoryIds) {
    await persistUnsubscribeLedger(db, {
      tenantId,
      normalizedEmail,
      unsubscribeType: 'category',
      categoryId,
      campaignId,
      now,
    });
  }
}

export async function removeExternalGlobalOptOut(db, { tenantId, email }) {
  await removeUnsubscribeLedger(db, {
    tenantId,
    normalizedEmail: normalizeSubscriberEmail(email),
    unsubscribeType: 'all',
  });
}