import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBooking } from './fixtures/publicGroupBooking.mjs';

for (const complex of [false, true]) {
  for (const identity of ['guest', 'non-group', 'active']) {
    test(`${complex ? 'complex' : 'simple'} public ${identity} completes free registration`, async () => {
      const { response, harness } = await groupBooking({ complex, identity });
      assert.equal(response.success, true, JSON.stringify(response));
      assert.equal(harness.rows[complex ? 'complex_event_booking' : 'booking'].length, 1);
      assert.equal(harness.calls.some(c => c.table === 'member_group_assignment' && c.operation !== 'select'), false);
    });
  }
  for (const flag of [false, undefined, 'true']) {
    for (const identity of ['guest', 'non-group']) {
      test(`${complex ? 'complex' : 'simple'} private ${String(flag)} blocks ${identity} despite request public flag`, async () => {
        const { response, harness } = await groupBooking({ complex, identity, flag: flag === undefined ? null : flag });
        assert.match(response.error, /group/);
        assert.equal(harness.rows[complex ? 'complex_event_booking' : 'booking'].length, 0);
      });
    }
  }
  test(`${complex ? 'complex' : 'simple'} private active member succeeds`, async () => {
    const { response } = await groupBooking({ complex, identity: 'active', flag: false });
    assert.equal(response.success, true, JSON.stringify(response));
  });
  for (const restriction of [{ expired: true }, { inactive: true }, { forged: true }]) {
    test(`${complex ? 'complex' : 'simple'} private rejects ${JSON.stringify(restriction)}`, async () => {
      const { response } = await groupBooking({ complex, identity: 'active', flag: false, ...restriction });
      assert.match(response.error, /group/);
    });
  }
  test(`${complex ? 'complex' : 'simple'} public retains single attendee limit`, async () => {
    const { response } = await groupBooking({ complex, count: 2 });
    assert.match(response.error, /self-registration/);
  });
  for (const identity of ['guest', 'active']) {
    test(`${complex ? 'complex' : 'simple'} public ${identity} cannot book another attendee`, async () => {
      const { response } = await groupBooking({ complex, identity, otherAttendee: true });
      assert.match(response.error, /self-registration/);
    });
  }
  test(`${complex ? 'complex' : 'simple'} public does not unlock member tickets`, async () => {
    const { response } = await groupBooking({ complex, ticketMode: 'members_only' });
    assert.match(response.error, /ticket|member/i);
  });
  test(`${complex ? 'complex' : 'simple'} public does not unlock role-restricted tickets`, async () => {
    const { response } = await groupBooking({ complex, restricted: true });
    assert.match(response.error, /ticket|member/i);
  });
  test(`${complex ? 'complex' : 'simple'} public member can register for eligible member-only ticket`, async () => {
    const { response } = await groupBooking({ complex, identity: 'active', ticketMode: 'members_only', restricted: true });
    assert.equal(response.success, true, JSON.stringify(response));
  });
  for (const identity of ['guest', 'active']) {
    test(`${complex ? 'complex' : 'simple'} public-only ticket eligibility for ${identity}`, async () => {
      const { response } = await groupBooking({ complex, identity, ticketMode: 'public_only' });
      if (identity === 'guest') assert.equal(response.success, true, JSON.stringify(response));
      else assert.match(response.error, /ticket/);
    });
  }
}

for (const forged of [true, 'different-session']) {
  for (const restricted of [false, true]) {
    test(`simple public rejects forged member identity: ${forged}, restricted=${restricted}`, async () => {
      const { response, harness } = await groupBooking({ identity: 'active', forged, restricted });
      assert.match(response.error, /logged in/);
      assert.equal(harness.rows.booking.length, 0);
    });
  }
}
