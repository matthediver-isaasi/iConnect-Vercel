// CPD configuration must not advertise an evidence source which cannot be
// persisted/normalized by the deployed database.  Keep this deliberately
// metadata-only: callers receive no provider connection or organiser details.
export function teamsCapabilityFromProbes(probes) {
  const ready = probes?.attendanceTarget === true
    && probes?.teamsTargetFields === true
    && probes?.teamsBinding === true
    && probes?.teamsMeetingFields === true;
  return {
    available: ready,
    warning: ready
      ? null
      : 'Teams attendance evidence is unavailable until the Teams attendance database migration is installed.',
  };
}

export function capabilityResponseFromProbes(probes) {
  const teams = teamsCapabilityFromProbes(probes);
  const zoomReady = probes?.attendanceTarget === true
    && probes?.currentOutcome === true
    && probes?.transitionOutbox === true;
  const qrReady = probes?.simpleCheckin === true && probes?.complexCheckin === true;
  const qr = {
    available: qrReady,
    warning: qrReady ? null : 'QR check-in attendance evidence is unavailable until the check-in database migration is installed.',
  };
  const zoom = {
    available: zoomReady,
    warning: zoomReady ? null : 'Zoom attendance evidence is unavailable until the provider-neutral attendance database migration is installed.',
  };
  return {
    qr,
    zoom,
    teams,
    // Convenient, non-sensitive flat contract for API/UI consumers.
    warnings: [qr.warning, zoom.warning, teams.warning].filter(Boolean),
  };
}

async function supportsSelect(db, table, columns) {
  try {
    const { error } = await db.from(table).select(columns).limit(1);
    if (error) throw error;
    return true;
  } catch (error) {
    if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error?.code)) return false;
    // Infrastructure/permission errors are not evidence of a missing migration.
    throw error;
  }
}

export async function detectEventCpdAttendanceCapabilities(db) {
  const [attendanceTarget, teamsBinding, currentOutcome, transitionOutbox, simpleCheckin, complexCheckin] = await Promise.all([
    supportsSelect(db, 'attendance_target', 'id,provider'),
    supportsSelect(db, 'teams_attendance_binding', 'id'),
    supportsSelect(db, 'attendance_current_outcome', 'provider,status,booking_type,booking_id'),
    supportsSelect(db, 'attendance_transition_outbox', 'id,status'),
    supportsSelect(db, 'booking', 'checked_in_at,check_in_reversed_at'),
    supportsSelect(db, 'complex_event_session_checkin', 'id,tenant_id,complex_event_id,booking_id,session_id,checked_in_at,check_in_reversed_at'),
  ]);
  // The binding is installed with these fields. Do not repeatedly query
  // unsupported columns on installations where Teams has never been installed.
  const teamsTargetFields = teamsBinding && await supportsSelect(db, 'attendance_target', 'provider_connection_id,provider_organiser_id');
  const teamsMeetingFields = teamsBinding && (await Promise.all(
    ['event', 'complex_event_session', 'event_agenda_item'].map((table) =>
      supportsSelect(db, table, 'online_provider,teams_online_meeting_id'))
  )).every(Boolean);
  return capabilityResponseFromProbes({
    attendanceTarget,
    teamsTargetFields,
    teamsBinding,
    teamsMeetingFields,
    currentOutcome,
    transitionOutbox,
    simpleCheckin,
    complexCheckin,
  });
}