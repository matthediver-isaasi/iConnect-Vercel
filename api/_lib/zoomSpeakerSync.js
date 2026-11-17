const emailKey = value => String(value || '').trim().toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// Zoom can acknowledge an add without echoing the panelist identity. Only
// after a successful POST may a complete read-back establish the created ID.
export async function resolveCreatedZoomPanelist(response, person, list) {
  const echoed = response?.panelists?.filter(p => emailKey(p.email) === emailKey(person.email)) || [];
  if (echoed.length === 1 && echoed[0].id) return echoed[0];
  const matches = (await list()).filter(p => emailKey(p.email) === emailKey(person.email));
  if (matches.length !== 1 || !matches[0].id) {
    throw new Error('Successful Zoom panelist addition could not be verified. The next attempt will reconcile without resending.');
  }
  return matches[0];
}

// No ambient credentials or database: exercised with fake providers in tests.
export async function reconcileZoomSpeakers(job, io) {
  const managed = structuredClone(job.managed || {});
  const summary = { added: 0, removed: 0, matched: 0, invalidSpeakers: 0, uncertain: 0 };
  const checkpoint = patch => io.save({ managed, summary, ...patch });
  const fence = async () => {
    if (!await io.fence()) throw new Error('Speakers changed during synchronisation; retrying the latest selection.');
  };
  try {
    if (job.webinar_status !== 'scheduled' || !Number.isFinite(Date.parse(job.start_time))
      || Date.parse(job.start_time) <= Date.now()) {
      await checkpoint({ status: 'attention', error: 'Panelists can only be synchronised before a scheduled webinar starts.' });
      return;
    }
    if (job.duplicate_targets) throw new Error('Multiple local records identify this webinar. Review the webinar links before synchronising.');
    const desired = new Map();
    for (const speaker of job.desired || []) {
      const email = emailKey(speaker.email);
      if (!speaker.found || !validEmail(email) || !String(speaker.name || '').trim()) {
        summary.invalidSpeakers++;
      } else if (!desired.has(email)) desired.set(email, String(speaker.name).trim());
    }
    const panelists = await io.list();
    const live = new Map();
    for (const person of panelists) {
      const email = emailKey(person.email);
      if (!person.id || !validEmail(email) || live.has(email)) throw new Error('Zoom returned incomplete or duplicate panelist identities. No removal was attempted.');
      live.set(email, person);
    }
    for (const [email, name] of desired) {
      if (io.expired()) { await checkpoint({ status: 'pending' }); return; }
      let person = live.get(email);
      const ours = managed[email];
      if (person && ours?.owned && ours.id === person.id && ours.name !== name) {
        // Zoom has no panelist rename operation: replace only our own entry.
        await fence();
        await io.remove(person.id);
        delete managed[email]; live.delete(email); person = null; summary.removed++;
        await checkpoint({});
      }
      if (person) {
        summary.matched++;
        if (ours?.creating) {
          // The prior response was lost. Do not resend an invitation or assume
          // ownership of a panelist that might have been added manually.
          managed[email] = { id: person.id, name, owned: false, uncertain: true };
          await checkpoint({});
        }
        if (managed[email]?.uncertain) summary.uncertain++;
        continue;
      }
      await fence();
      managed[email] = { name, creating: true, owned: false };
      await checkpoint({});
      await fence();
      const added = await io.add({ name, email });
      if (!added?.id || emailKey(added.email) !== email) throw new Error('Zoom panelist response needs verification. The next attempt will check Zoom before sending again.');
      managed[email] = { name, id: added.id, owned: true };
      summary.added++;
      await checkpoint({});
    }
    // An incomplete desired set is never authority to delete existing entries.
    if (!summary.invalidSpeakers) {
      for (const [email, ours] of Object.entries(managed)) {
        if (desired.has(email)) continue;
        if (io.expired()) { await checkpoint({ status: 'pending' }); return; }
        const person = live.get(email);
        if (ours.owned && person && person.id === ours.id) {
          await fence();
          await io.remove(ours.id);
          summary.removed++;
        }
        delete managed[email];
        await checkpoint({});
      }
    }
    await fence();
    await checkpoint({
      status: summary.invalidSpeakers || summary.uncertain ? 'attention' : 'completed',
      error: summary.invalidSpeakers ? 'Some selected speakers are missing a name or valid email, or no longer exist. Existing panelists were retained.'
        : summary.uncertain ? 'A previous Zoom response was interrupted. The panelists exist; ownership needs review before automatic removal.' : null,
    });
  } catch (error) {
    await checkpoint({ status: 'pending', error: error.message });
  }
}
