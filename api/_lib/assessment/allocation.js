// Preview only: database confirmation must recheck the exact source versions
// under row locks. A preview is never assignment authority.
export function previewAllocation({ mode, applications, appointments, assignments = [], conflicts = [], requiredJudges, manual = [] }) {
  if (!['all', 'balanced', 'manual'].includes(mode)) throw new Error('Unknown allocation mode');
  if (!Number.isInteger(requiredJudges) || requiredJudges < 1 || requiredJudges > 100) throw new Error('Invalid required judge count');
  for (const rows of [applications, appointments]) {
    if (!Array.isArray(rows) || new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate allocation input');
  }
  const eligible = applications.filter(a => a.eligibility === 'eligible').sort((a,b) => a.id.localeCompare(b.id));
  const judges = appointments.filter(j => j.state === 'accepted' && j.available && ['judge','chair'].includes(j.role));
  if (judges.some(j => !Number.isInteger(j.capacity) || j.capacity < 0)) throw new Error('Invalid judge capacity');
  const key = (applicationId, appointmentId) => `${applicationId}:${appointmentId}`;
  const existing = new Set(assignments.map(a => key(a.applicationId, a.appointmentId)));
  if (existing.size !== assignments.length) throw new Error('Duplicate existing assignment');
  const workload = new Map(judges.map(j => [j.id, assignments.filter(a => a.appointmentId === j.id && a.state === 'assigned').length]));
  const blocked = new Set(conflicts.filter(c => ['potential','confirmed'].includes(c.state)).map(c => key(c.applicationId,c.appointmentId)));
  const planned = [], shortages = [];
  function available(application, judge) {
    return !existing.has(key(application.id, judge.id)) && !blocked.has(key(application.id, judge.id))
      && workload.get(judge.id) < judge.capacity;
  }
  function add(application, judge) {
    if (!available(application, judge)) throw new Error('Assignment is duplicate, conflicted or exceeds availability');
    planned.push({ applicationId: application.id, appointmentId: judge.id });
    existing.add(key(application.id,judge.id)); workload.set(judge.id,workload.get(judge.id)+1);
  }
  if (mode === 'manual') {
    for (const pair of manual) {
      const application = eligible.find(a => a.id === pair.applicationId), judge = judges.find(j => j.id === pair.appointmentId);
      if (!application || !judge) throw new Error('Application or judge is unavailable');
      add(application,judge);
    }
  } else {
    for (const application of eligible) {
      const current = assignments.filter(a => a.applicationId === application.id && a.state === 'assigned'
        && judges.some(j => j.id === a.appointmentId) && !blocked.has(key(a.applicationId,a.appointmentId))).length;
      const needed = mode === 'all' ? judges.length - current : Math.max(0, requiredJudges - current);
      for (let i=0; i<needed; i++) {
        const candidate = judges.filter(j => available(application,j))
          .sort((a,b) => workload.get(a.id)-workload.get(b.id) || a.id.localeCompare(b.id))[0];
        if (!candidate) break;
        add(application,candidate);
      }
    }
  }
  for (const application of eligible) {
    const count = assignments.filter(a => a.applicationId===application.id && a.state==='assigned'
      && judges.some(j=>j.id===a.appointmentId) && !blocked.has(key(a.applicationId,a.appointmentId))).length
      + planned.filter(a=>a.applicationId===application.id).length;
    const expected = mode === 'all' ? Math.max(requiredJudges,judges.length) : requiredJudges;
    if (count < expected) shortages.push({ applicationId: application.id, missing: expected-count });
  }
  return { assignments: planned, shortages, workload: Object.fromEntries(workload) };
}
