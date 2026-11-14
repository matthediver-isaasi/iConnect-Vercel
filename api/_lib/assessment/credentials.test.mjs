import test from 'node:test';
import assert from 'node:assert/strict';
import { newCredential, credentialHash, matchesCredential, judgingCookie, readJudgingCookie, checkJudgingCsrf, JUDGING_COOKIE } from './credentials.js';
test('credentials use secure random values, hashes and constant-time matching', () => {
  const a=newCredential(), b=newCredential();
  assert.notEqual(a,b); assert.equal(a.length,43); assert.equal(credentialHash(a).length,64);
  assert.equal(matchesCredential(a,credentialHash(a)),true);
  assert.equal(matchesCredential(b,credentialHash(a)),false);
  assert.equal(credentialHash('bad'),null);
  assert.equal(matchesCredential({},credentialHash(a)),false);
});
test('restricted cookie is host-only, secure and HttpOnly; duplicate cookies rejected', () => {
  const token=newCredential(), value=judgingCookie(token,'2027-01-01T00:00:00Z');
  assert.match(value,/Path=\/; HttpOnly; Secure; SameSite=Strict/);
  assert.equal(value.includes('Domain='),false);
  assert.equal(readJudgingCookie({headers:{cookie:`${JUDGING_COOKIE}=${token}`}}),token);
  assert.equal(readJudgingCookie({headers:{cookie:`${JUDGING_COOKIE}=${token}; ${JUDGING_COOKIE}=${token}`}}),null);
});
test('CSRF needs the correct session-bound proof and a non-cross-site JSON request', () => {
  const token=newCredential(), hash=credentialHash(token);
  const headers={'content-type':'application/json','x-judging-csrf':token};
  assert.equal(checkJudgingCsrf({headers},hash),true);
  assert.equal(checkJudgingCsrf({headers:{...headers,'sec-fetch-site':'cross-site'}},hash),false);
  assert.equal(checkJudgingCsrf({headers:{...headers,'x-judging-csrf':newCredential()}},hash),false);
});
