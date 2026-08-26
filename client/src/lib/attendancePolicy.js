export const ATTENDANCE_PROVIDERS = Object.freeze({
  ZOOM: 'zoom',
  TEAMS: 'teams',
});

export const DEFAULT_ATTENDANCE_THRESHOLD_MINUTES = 1;

export function normalizeAttendancePolicy(source = {}, { inherit = false } = {}) {
  const rawThreshold = Number(source.attendance_threshold_minutes);
  return {
    attendance_tracking_enabled: source.attendance_tracking_enabled === true,
    attendance_provider: source.attendance_provider || ATTENDANCE_PROVIDERS.ZOOM,
    attendance_threshold_minutes:
      Number.isInteger(rawThreshold) && rawThreshold >= 1
        ? rawThreshold
        : DEFAULT_ATTENDANCE_THRESHOLD_MINUTES,
    ...(inherit
      ? {
        attendance_policy_inherit: typeof source.attendance_policy_inherit === 'boolean'
          ? source.attendance_policy_inherit
          : source.attendance_policy_override !== true,
      }
      : {}),
  };
}

export function attendancePolicyPayload(policy, { inherit = false } = {}) {
  const normalized = normalizeAttendancePolicy(policy, { inherit });
  if (inherit && normalized.attendance_policy_inherit) {
    return {
      attendance_policy_override: false,
      attendance_tracking_enabled: null,
      attendance_provider: null,
      attendance_threshold_minutes: null,
    };
  }
  return {
    attendance_tracking_enabled: normalized.attendance_tracking_enabled,
    attendance_provider: normalized.attendance_tracking_enabled
      ? normalized.attendance_provider
      : null,
    attendance_threshold_minutes: normalized.attendance_threshold_minutes,
    ...(inherit
      ? { attendance_policy_override: true }
      : {}),
  };
}

export function resolveAttendancePolicy(parentPolicy, childPolicy) {
  const child = normalizeAttendancePolicy(childPolicy, { inherit: true });
  if (child.attendance_policy_inherit) {
    return {
      ...normalizeAttendancePolicy(parentPolicy),
      attendance_policy_inherit: true,
    };
  }
  return child;
}

export function hasSupportedZoomTarget({
  isOnline,
  zoomMeetingId,
  zoomWebinarId,
  zoomAutoCreate = false,
} = {}) {
  return Boolean(isOnline && (zoomMeetingId || zoomWebinarId || zoomAutoCreate));
}

export function hasSupportedTeamsTarget({
  isOnline,
  teamsOnlineMeetingId,
  teamsJoinWebUrl,
  teamsOrganiserMicrosoftUserId,
  teamsOutlookConnectionId,
} = {}) {
  return Boolean(isOnline && teamsOnlineMeetingId && teamsJoinWebUrl
    && teamsOrganiserMicrosoftUserId && teamsOutlookConnectionId);
}

export function hasSupportedAttendanceTarget(policy, target = {}) {
  const provider = normalizeAttendancePolicy(policy).attendance_provider;
  if (provider === ATTENDANCE_PROVIDERS.ZOOM) return hasSupportedZoomTarget(target);
  if (provider === ATTENDANCE_PROVIDERS.TEAMS) return hasSupportedTeamsTarget(target);
  return false;
}

export function validateAttendancePolicy(policy, target, label = 'Attendance tracking') {
  const normalized = normalizeAttendancePolicy(policy);
  if (!normalized.attendance_tracking_enabled) return [];
  if (![ATTENDANCE_PROVIDERS.ZOOM, ATTENDANCE_PROVIDERS.TEAMS].includes(normalized.attendance_provider)) {
    return [`${label} uses an unsupported online provider`];
  }
  if (!hasSupportedAttendanceTarget(normalized, target)) {
    return [`${label} requires a linked ${normalized.attendance_provider === ATTENDANCE_PROVIDERS.TEAMS ? 'Teams meeting' : 'Zoom meeting or webinar'}`];
  }
  if (!Number.isInteger(normalized.attendance_threshold_minutes)
      || normalized.attendance_threshold_minutes < 1) {
    return [`${label} qualifying duration must be at least 1 minute`];
  }
  return [];
}

export function describeAttendancePolicy(policy) {
  const normalized = normalizeAttendancePolicy(policy);
  if (!normalized.attendance_tracking_enabled) return 'Attendance tracking is off';
  const provider = normalized.attendance_provider === ATTENDANCE_PROVIDERS.TEAMS ? 'Teams' : 'Zoom';
  return `${provider} attendance: ${normalized.attendance_threshold_minutes} minute${normalized.attendance_threshold_minutes === 1 ? '' : 's'} required`;
}