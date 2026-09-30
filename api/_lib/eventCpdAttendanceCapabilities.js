// CPD configuration must not advertise an evidence source which cannot be
// persisted/normalized by the deployed database.  Keep this deliberately
// metadata-only: callers receive no provider connection or organiser details.
export function teamsCapabilityFromProbes(probes) {
  const ready = probes?.attendanceTarget === true
    && probes?.teamsTargetFields === true
    && probes?.teamsBinding === true
    && probes?.complexEventFields === true;
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
    return !error;
  } catch {
    // Missing relation/column versions of PostgREST can throw as well as
    // return an error. A rules screen should remain usable in either case.
    return false;
  }
}

export async function detectEventCpdAttendanceCapabilities(db) {
  const [attendanceTarget, teamsTargetFields, teamsBinding, complexEventFields, currentOutcome, transitionOutbox, simpleCheckin, complexCheckin] = await Promise.all([
    supportsSelect(db, 'attendance_target', 'id,provider'),
    supportsSelect(db, 'attendance_target', 'provider_connection_id,provider_organiser_id'),
    supportsSelect(db, 'teams_attendance_binding', 'id'),
    supportsSelect(db, 'complex_event', 'online_provider,teams_online_meeting_id'),
    supportsSelect(db, 'attendance_current_outcome', 'provider,status,booking_type,booking_id'),
    supportsSelect(db, 'attendance_transition_outbox', 'id,status'),
    supportsSelect(db, 'booking', 'checked_in_at,check_in_reversed_at'),
    supportsSelect(db, 'complex_event_session_checkin', 'id,tenant_id,complex_event_id,booking_id,session_id,checked_in_at,check_in_reversed_at'),
  ]);
  return capabilityResponseFromProbes({
    attendanceTarget,
    teamsTargetFields,
    teamsBinding,
    complexEventFields,
    currentOutcome,
    transitionOutbox,
    simpleCheckin,
    complexCheckin,
  });
}