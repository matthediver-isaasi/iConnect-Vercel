import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clearTeamsMeeting, hasTeamsMeeting, normalizeTeamsMeeting } from './teamsMeeting.js';

describe('Teams meeting identity', () => {
  it('normalizes the stable Graph identity returned by the API', () => {
    assert.deepEqual(normalizeTeamsMeeting({
      id: 'graph-id',
      joinWebUrl: 'https://teams.microsoft.com/l/meetup-join/test',
      organizerId: 'organizer-id',
      organizerEmail: 'host@example.com',
      connectionId: 'connection-id',
    }), {
      teams_online_meeting_id: 'graph-id',
      teams_join_web_url: 'https://teams.microsoft.com/l/meetup-join/test',
      teams_organiser_microsoft_user_id: 'organizer-id',
      teams_organiser_email: 'host@example.com',
      teams_outlook_connection_id: 'connection-id',
      teams_meeting_lifecycle: 'active',
    });
  });

  it('does not treat a join URL alone as a supported attendance target', () => {
    assert.equal(hasTeamsMeeting({ teams_join_web_url: 'https://teams.microsoft.com/test' }), false);
    assert.equal(Object.values(clearTeamsMeeting()).every((value) => value === null), true);
  });
});
