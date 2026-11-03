import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Preferences.jsx', import.meta.url), 'utf8');

test('affiliations follows the information section within configurable ordering', () => {
  assert.equal((source.match(/<MemberAffiliations\b/g) || []).length, 1);
  assert.match(source, /sectionOrder\.map\(\(sectionId\) => \(\s*<React\.Fragment key=\{sectionId\}>\s*\{renderSection\(sectionId\)\}\s*\{sectionId === 'profile_information' && memberRecord\?\.id && <MemberAffiliations/);
  assert.match(source, /MemberAffiliations key=\{memberRecord\.id\} onSaved=\{async \(\) =>/);
  assert.match(source, /invalidateQueries\(\{ queryKey: \["organization"\] \}\)/);
  assert.match(source, /invalidateQueries\(\{ queryKey: \["member-departments"\] \}\)/);
  assert.match(source, /invalidateQueries\(\{ queryKey: profileQueryKey\(memberRecord\.id\), exact: true \}\)/);
  assert.match(source, /throw new Error\("Updated member identity could not be confirmed\."\)/);
  assert.match(source, /await synchronizeProfile\(\{[\s\S]*?patch: \{ organization_id: confirmed\.organization_id,[\s\S]*?sessionMember, setSessionMember, storage: localStorage/);
});

test('expiry subcard uses the shared hook and sits immediately below Member since', () => {
  assert.match(source, /const membershipSummary = useCanvasMembershipSummary\(\)/);
  assert.match(source, /const membershipValidUntil = currentPersonalMembershipExpiry\(membershipSummary\)/);
  assert.match(source, /Member since<\/p>[\s\S]*?<\/div>\s*<\/div>\s*\{membershipValidUntil && \(\s*<div className="flex items-center gap-2 p-4 bg-slate-50 rounded-lg border border-slate-200" data-testid="membership-valid-until">/);
  assert.match(source, /Membership valid until<\/p>\s*<p[^>]*>\{membershipValidUntil\}<\/p>/);
});
