import {
  isMemberEligibleForCommunicationCategory,
  normalizeCommunicationRoleIds,
} from '../../shared/communicationCategoryMembership.js';

export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';

const COLLECTIONS = ['members', 'categories', 'assignments', 'roles', 'preferences', 'ledgers', 'subscribers'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const emailOf = (email) => email == null ? '' : email.trim().toLowerCase();

function requireId(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function requireReference(id, lookup, label) {
  requireId(id, label);
  if (!lookup.has(id)) throw new Error(`${label} references unknown or cross-tenant id ${id}`);
}

function validateEmail(value, label, optional = false) {
  if (optional && (value == null || (typeof value === 'string' && !emailOf(value)))) return '';
  if (typeof value !== 'string' || !emailOf(value)) throw new Error(`${label} must have an email`);
  return emailOf(value);
}

function indexRows(rows, name) {
  const result = new Map();
  for (const row of rows) {
    requireId(row.id, `${name}.id`);
    if (result.has(row.id)) throw new Error(`Duplicate ${name} id ${row.id}`);
    result.set(row.id, row);
  }
  return result;
}

/**
 * Compute a read-only, deterministic reset plan from a complete tenant snapshot.
 * An add/change refers to a member_communication_preference upsert to true;
 * clearGlobal refers to an update of communications_opted_out_all to false.
 */
export function buildResetPlan(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('snapshot must be an object');
  }
  for (const name of COLLECTIONS) {
    if (!Array.isArray(snapshot[name])) throw new Error(`snapshot.${name} must be an array`);
    for (const [index, row] of snapshot[name].entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`${name}[${index}] must be a row`);
      }
      if (row.tenant_id !== TENANT_ID) {
        throw new Error(`${name}[${index}] tenant_id mismatch`);
      }
    }
  }

  const members = indexRows(snapshot.members, 'members');
  const categories = indexRows(snapshot.categories, 'categories');
  const roles = indexRows(snapshot.roles, 'roles');
  indexRows(snapshot.assignments, 'assignments');
  indexRows(snapshot.preferences, 'preferences');
  indexRows(snapshot.ledgers, 'ledgers');
  indexRows(snapshot.subscribers, 'subscribers');

  const rolesByCategory = new Map();
  for (const assignment of snapshot.assignments) {
    requireReference(assignment.category_id, categories, 'assignment.category_id');
    requireReference(assignment.role_id, roles, 'assignment.role_id');
    const applicable = rolesByCategory.get(assignment.category_id) || [];
    applicable.push(assignment.role_id);
    rolesByCategory.set(assignment.category_id, applicable);
  }
  const preferences = new Map();
  let orphanPreferences = 0;
  for (const preference of snapshot.preferences) {
    requireReference(preference.category_id, categories, 'preference.category_id');
    if (preference.is_subscribed != null && typeof preference.is_subscribed !== 'boolean') {
      throw new Error(`preference ${preference.id} has invalid is_subscribed`);
    }
    if (preference.member_id == null) {
      orphanPreferences++;
      continue;
    }
    requireReference(preference.member_id, members, 'preference.member_id');
    const key = JSON.stringify([preference.member_id, preference.category_id]);
    if (preferences.has(key)) throw new Error(`Duplicate preference for ${key}`);
    preferences.set(key, preference);
  }

  const activeCategories = snapshot.categories.filter((category) => category.is_active === true)
    .sort((a, b) => compare(a.id, b.id));
  const targets = [];
  let excludedDeleted = 0;
  let disabledLoginMembers = 0;
  let missingEmails = 0;
  const groups = new Map();
  for (const member of [...snapshot.members].sort((a, b) => compare(a.id, b.id))) {
    const email = validateEmail(member.email, `member ${member.id}`, true);
    if (member.status != null && typeof member.status !== 'string') {
      throw new Error(`member ${member.id} has invalid status`);
    }
    for (const roleId of normalizeCommunicationRoleIds(member.role_id)) {
      requireReference(roleId, roles, `member ${member.id} role_id`);
    }
    if (member.role_id != null && member.role_id !== '' &&
        !(typeof member.role_id === 'string' || Array.isArray(member.role_id))) {
      throw new Error(`member ${member.id} has invalid role_id`);
    }
    const deleted = /^deleted_.*@deleted\.local$/i.test(email) ||
      ['deleted', 'anonymized'].includes(member.status?.trim().toLowerCase());
    if (deleted) {
      excludedDeleted++;
      continue;
    }
    if (member.login_enabled === false) disabledLoginMembers++;
    if (!email) missingEmails++;
    if (member.communications_opted_out_all != null &&
        typeof member.communications_opted_out_all !== 'boolean') {
      throw new Error(`member ${member.id} has invalid communications_opted_out_all`);
    }
    const categoryIds = activeCategories
      .filter((category) => isMemberEligibleForCommunicationCategory(
        member, rolesByCategory.get(category.id) || [], category,
      ))
      .map((category) => category.id);
    const addCategoryIds = [];
    const changeCategoryIds = [];
    for (const categoryId of categoryIds) {
      const preference = preferences.get(JSON.stringify([member.id, categoryId]));
      if (!preference) addCategoryIds.push(categoryId);
      else if (preference.is_subscribed !== true) changeCategoryIds.push(categoryId);
    }
    targets.push({
      id: member.id,
      email: email || null,
      categoryIds,
      clearGlobal: member.communications_opted_out_all !== false,
      addCategoryIds,
      changeCategoryIds,
    });
    if (email) {
      const group = groups.get(email) || [];
      group.push(targets[targets.length - 1]);
      groups.set(email, group);
    }
  }

  let duplicateEmailGroups = 0;
  for (const [email, group] of groups) {
    if (group.length < 2) continue;
    duplicateEmailGroups++;
    const expected = JSON.stringify(group[0].categoryIds);
    if (group.some((member) => JSON.stringify(member.categoryIds) !== expected)) {
      throw new Error(`Conflicting eligible categories for duplicate email ${email}`);
    }
  }

  let overlappingSubscribers = 0;
  for (const subscriber of snapshot.subscribers) {
    const email = validateEmail(subscriber.email, `subscriber ${subscriber.id}`);
    if (subscriber.communication_category_id != null) {
      requireReference(subscriber.communication_category_id, categories, 'subscriber.communication_category_id');
    }
    if (subscriber.opted_out != null && typeof subscriber.opted_out !== 'boolean') {
      throw new Error(`subscriber ${subscriber.id} has invalid opted_out`);
    }
    if (groups.has(email)) {
      overlappingSubscribers++;
      if (subscriber.opted_out === true) {
        throw new Error(`Conflicting opted-out external subscriber for email ${email}`);
      }
    }
  }

  const removeLedgerIds = [];
  let globalSuppressionsRemoved = 0;
  let categorySuppressionsRemoved = 0;
  let historicalEmailSuppressions = 0;
  for (const ledger of snapshot.ledgers) {
    const email = validateEmail(ledger.email, `ledger ${ledger.id}`);
    if (ledger.member_id != null) {
      requireReference(ledger.member_id, members, 'ledger.member_id');
      if (groups.has(email) && !groups.get(email).some((member) => member.id === ledger.member_id)) {
        throw new Error(`Ledger ${ledger.id} member_id outside email group ${email}`);
      }
      if (!groups.has(email) && emailOf(members.get(ledger.member_id).email) !== email) {
        historicalEmailSuppressions++;
      }
    }
    if (ledger.communication_category_id != null) {
      requireReference(ledger.communication_category_id, categories, 'ledger.communication_category_id');
    }
    if (!['all', 'category', 'campaign'].includes(ledger.unsubscribe_type)) {
      throw new Error(`Ledger ${ledger.id} has unknown unsubscribe_type`);
    }
    if ((ledger.unsubscribe_type === 'all' && ledger.communication_category_id != null) ||
        (ledger.unsubscribe_type === 'category' && ledger.communication_category_id == null)) {
      throw new Error(`Ambiguous ledger ${ledger.id} category`);
    }
    const group = groups.get(email);
    if (!group) continue;
    if (ledger.unsubscribe_type === 'all') {
      removeLedgerIds.push(ledger.id);
      globalSuppressionsRemoved++;
    } else if (ledger.unsubscribe_type === 'category' &&
        group[0].categoryIds.includes(ledger.communication_category_id)) {
      removeLedgerIds.push(ledger.id);
      categorySuppressionsRemoved++;
    }
  }
  removeLedgerIds.sort(compare);

  return {
    members: targets,
    removeLedgerIds,
    summary: {
      totalMembers: snapshot.members.length,
      excludedDeleted,
      membersCovered: targets.length,
      disabledLoginMembers,
      missingEmails,
      orphanPreferences,
      historicalEmailSuppressions,
      duplicateEmailGroups,
      subscriptionsAdded: targets.reduce((count, target) => count + target.addCategoryIds.length, 0),
      subscriptionsChanged: targets.reduce((count, target) => count + target.changeCategoryIds.length, 0),
      globalFlagsCleared: targets.filter((target) => members.get(target.id).communications_opted_out_all === true).length,
      globalFlagsNormalized: targets.filter((target) => members.get(target.id).communications_opted_out_all == null).length,
      globalSuppressionsRemoved,
      categorySuppressionsRemoved,
      eligiblePairs: targets.reduce((count, target) => count + target.categoryIds.length, 0),
      overlappingSubscribers,
    },
  };
}