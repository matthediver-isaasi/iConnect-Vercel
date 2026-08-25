import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const loginSource = read('../auth/login.js');
const googleSource = read('../auth/google/callback.js');
const setPasswordSource = read('../auth/set-password.js');
const portalSsoSource = read('../auth/portal-sso.js');
const mobileSource = read('../auth/mobile-login.js');
const tenantSwitchSource = read('../auth/tenant-switch.js');

test('direct member login routes return the shared unavailable response before issuing a session', () => {
  const directRoutes = [
    ['password login', loginSource, 'await createSession'],
    ['password setup auto-login', setPasswordSource, 'await createSession'],
    ['mobile member login', mobileSource, 'const created = await createBearerSession'],
  ];

  for (const [name, source, sessionBoundary] of directRoutes) {
    const gateAt = source.indexOf('await evaluateMemberPortalLoginGate');
    const sessionAt = source.indexOf(sessionBoundary);
    assert.ok(gateAt > -1, `${name} must evaluate the member portal gate`);
    assert.ok(sessionAt > gateAt, `${name} must evaluate the gate before issuing a session`);

    const blockedBranch = source.slice(gateAt, sessionAt);
    assert.match(blockedBranch, /status\(403\)/, `${name} must return HTTP 403`);
    assert.match(blockedBranch, /error:\s*portalGateResult\.message/);
    assert.match(blockedBranch, /memberPortalLoginUnavailable:\s*true/);
  }
});

test('member tenant switch is gated while tenant-user switch branches remain unchanged', () => {
  const memberBranchAt = tenantSwitchSource.indexOf('// Member - create member session');
  const gateAt = tenantSwitchSource.indexOf('await evaluateMemberPortalLoginGate', memberBranchAt);
  const sharedSessionAt = tenantSwitchSource.indexOf('await createSession', gateAt);

  assert.ok(memberBranchAt > -1);
  assert.ok(gateAt > memberBranchAt, 'member switch branch must evaluate the gate');
  assert.ok(sharedSessionAt > gateAt, 'member switch must be blocked before session creation');

  const blockedBranch = tenantSwitchSource.slice(gateAt, sharedSessionAt);
  assert.match(blockedBranch, /status\(403\)/);
  assert.match(blockedBranch, /error:\s*portalGateResult\.message/);
  assert.match(blockedBranch, /memberPortalLoginUnavailable:\s*true/);

  const tenantUserBranch = tenantSwitchSource.slice(0, memberBranchAt);
  assert.doesNotMatch(tenantUserBranch, /await evaluateMemberPortalLoginGate/);
});

test('redirect-based Google and Portal SSO attempts use the same unavailable reason', () => {
  for (const [name, source] of [
    ['Google callback', googleSource],
    ['Portal SSO', portalSsoSource],
  ]) {
    const gateAt = source.indexOf('await evaluateMemberPortalLoginGate');
    assert.ok(gateAt > -1, `${name} must evaluate the member portal gate`);

    const blockedBranch = source.slice(gateAt, gateAt + 800);
    assert.match(blockedBranch, /member_portal_unavailable/);
  }
});

test('all six requested member entry paths are wired to the shared evaluator', () => {
  for (const [name, source] of [
    ['password login', loginSource],
    ['Google callback', googleSource],
    ['password setup', setPasswordSource],
    ['Portal SSO', portalSsoSource],
    ['mobile login', mobileSource],
    ['tenant switch', tenantSwitchSource],
  ]) {
    assert.match(source, /evaluateMemberPortalLoginGate/, `${name} is missing the shared gate`);
  }
});