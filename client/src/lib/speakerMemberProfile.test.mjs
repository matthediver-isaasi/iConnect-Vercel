import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptySpeakerForm,
  memberToSpeakerForm,
  speakerToForm,
} from './speakerMemberProfile.js';

test('selecting a member hydrates every available speaker profile field', () => {
  const hydrated = memberToSpeakerForm(createEmptySpeakerForm(), {
    id: 'm1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
    job_title: 'Mathematician',
    organization_name: 'Analytical Engines Ltd',
    biography: 'Computing pioneer',
    profile_photo_url: 'https://example.com/ada.jpg',
  });
  assert.deepEqual(hydrated, {
    member_id: 'm1',
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
    organization: 'Analytical Engines Ltd',
    job_title: 'Mathematician',
    biography: 'Computing pioneer',
    profile_photo_url: 'https://example.com/ada.jpg',
    is_active: true,
  });
});

test('speaker-specific edits survive while the member link remains authoritative', () => {
  const hydrated = memberToSpeakerForm(createEmptySpeakerForm(), {
    id: 'm1',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email: 'ada@example.com',
  });
  const edited = { ...hydrated, biography: 'Event-specific biography' };
  assert.equal(edited.member_id, 'm1');
  assert.equal(edited.biography, 'Event-specific biography');
});

test('clearing a link leaves an editable ad-hoc profile and guest profiles stay unchanged', () => {
  const linked = memberToSpeakerForm(createEmptySpeakerForm(), {
    id: 'm1',
    first_name: 'Ada',
    email: 'ada@example.com',
  });
  const cleared = memberToSpeakerForm(linked, null);
  assert.equal(cleared.member_id, null);
  assert.equal(cleared.full_name, 'Ada');
  assert.equal(cleared.email, 'ada@example.com');

  const guest = speakerToForm({
    full_name: 'Guest Speaker',
    email: 'guest@example.com',
    biography: 'Guest biography',
  });
  assert.equal(guest.member_id, null);
  assert.equal(guest.full_name, 'Guest Speaker');
  assert.equal(guest.biography, 'Guest biography');
});