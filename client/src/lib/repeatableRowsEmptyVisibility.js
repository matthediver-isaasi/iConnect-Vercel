/**
 * Client-side projection for the opt-in repeatable-row empty-domain hiding
 * behaviour. The option resolver remains mounted while a container is hidden;
 * this module only decides whether a resolved domain is authoritative enough
 * to hide the presentation.
 */

export const REPEATABLE_EMPTY_AVAILABILITY_PENDING = 'pending';
export const REPEATABLE_EMPTY_AVAILABILITY_ERROR = 'error';
export const REPEATABLE_EMPTY_AVAILABILITY_MISSING_PREREQUISITE = 'missing_prerequisite';
export const REPEATABLE_EMPTY_AVAILABILITY_RESOLVED = 'resolved';
export const REPEATABLE_EMPTY_AVAILABILITY_UNSUPPORTED = 'unsupported';

export function resolveRepeatableFirstColumnVisibility({
  enabled = false,
  support = null,
  states = [],
} = {}) {
  if (!enabled || !support?.supported) {
    return {
      hidden: false,
      status: REPEATABLE_EMPTY_AVAILABILITY_UNSUPPORTED,
      reason: support?.reason || 'unsupported',
    };
  }

  const availability = Array.isArray(states) ? states.filter(Boolean) : [];
  if (availability.length === 0) {
    return {
      hidden: false,
      status: REPEATABLE_EMPTY_AVAILABILITY_PENDING,
      reason: 'resolver_pending',
    };
  }

  if (availability.some(state => (
    state.status === REPEATABLE_EMPTY_AVAILABILITY_PENDING
    || state.status === REPEATABLE_EMPTY_AVAILABILITY_ERROR
    || state.status === REPEATABLE_EMPTY_AVAILABILITY_MISSING_PREREQUISITE
  ))) {
    return {
      hidden: false,
      status: availability.find(state => state.status !== REPEATABLE_EMPTY_AVAILABILITY_RESOLVED)?.status
        || REPEATABLE_EMPTY_AVAILABILITY_PENDING,
      reason: 'domain_not_authoritative',
    };
  }

  // Sibling exhaustion is intentionally not represented here. Every row
  // reports the underlying domain (before sibling uniqueness filtering), so
  // an empty domain is authoritative only when every mounted row agrees.
  const hasOption = availability.some(state => Number(state.optionCount) > 0);
  return {
    hidden: !hasOption,
    status: REPEATABLE_EMPTY_AVAILABILITY_RESOLVED,
    reason: hasOption ? 'options_available' : 'empty_domain',
  };
}

export function repeatableAvailabilityState({
  support = null,
  loading = false,
  error = false,
  prerequisiteMissing = false,
  loaded = true,
  optionCount = 0,
} = {}) {
  if (!support?.supported) {
    return {
      status: REPEATABLE_EMPTY_AVAILABILITY_UNSUPPORTED,
      reason: support?.reason || 'unsupported',
      optionCount: 0,
    };
  }
  if (prerequisiteMissing) {
    return {
      status: REPEATABLE_EMPTY_AVAILABILITY_MISSING_PREREQUISITE,
      reason: 'missing_prerequisite',
      optionCount: 0,
    };
  }
  if (error) {
    return {
      status: REPEATABLE_EMPTY_AVAILABILITY_ERROR,
      reason: 'resolver_error',
      optionCount: 0,
    };
  }
  if (loading || !loaded) {
    return {
      status: REPEATABLE_EMPTY_AVAILABILITY_PENDING,
      reason: 'resolver_pending',
      optionCount: 0,
    };
  }
  return {
    status: REPEATABLE_EMPTY_AVAILABILITY_RESOLVED,
    reason: Number(optionCount) > 0 ? 'options_available' : 'empty_domain',
    optionCount: Number(optionCount) || 0,
  };
}