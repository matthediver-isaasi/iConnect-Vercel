import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDueDiligenceMemberId,
  getDueDiligenceOrganizationId,
  getDueDiligenceReferenceLabel,
} from './dueDiligenceReference.js';

test('member name wins over the member organisation label', () => {
  assert.equal(
    getDueDiligenceReferenceLabel({
      memberId: 'member-1',
      member: { id: 'member-1', first_name: 'Ada', last_name: 'Lovelace' },
      organizationId: 'org-1',
      organization: { id: 'org-1', name: 'Analytical Engines Ltd' },
      cardReferenceField: '__organization_name__',
    }),
    'Ada Lovelace',
  );
});

test('organisation applications prefer the organisation when both typed IDs exist', () => {
  assert.equal(
    getDueDiligenceReferenceLabel({
      applicationLevel: 'organization',
      memberId: 'member-1',
      member: { id: 'member-1', first_name: 'Contact', last_name: 'Person' },
      organizationId: 'org-1',
      organization: { id: 'org-1', name: 'Applicant Organisation' },
      cardReferenceField: '__organization_name__',
    }),
    'Applicant Organisation',
  );
});

test('deleted organisation uses the saved organisation answer before a created contact', () => {
  assert.equal(
    getDueDiligenceReferenceLabel({
      applicationLevel: 'organization',
      memberId: 'member-1',
      member: { id: 'member-1', first_name: 'Contact', last_name: 'Person' },
      organizationId: 'deleted-org',
      formValues: { organization_name: 'ApplicantOrg' },
      cardReferenceField: '__organization_name__',
    }),
    'ApplicantOrg',
  );
});

test('member applications preserve saved member evidence before an organisation fallback', () => {
  assert.equal(
    getDueDiligenceReferenceLabel({
      applicationLevel: 'member',
      memberId: 'deleted-member',
      member: null,
      organizationId: 'org-1',
      organization: { id: 'org-1', name: 'Contact Organisation' },
      formValues: { name: 'Saved Member Name' },
      cardReferenceField: '__organization_name__',
    }),
    'Saved Member Name',
  );
});

test('deleted member falls back to a real organisation without exposing the member UUID', () => {
  const memberId = '2b7c2b87-1866-4a3f-b520-7c57e4d288a4';
  assert.equal(
    getDueDiligenceReferenceLabel({
      memberId,
      organizationId: 'org-1',
      organization: { id: 'org-1', name: 'Analytical Engines Ltd' },
      formValues: { organization_name: memberId },
      applicationUid: 'DD-123',
    }),
    'Analytical Engines Ltd',
  );
});

test('missing member and organisation use the application reference, not a raw UUID', () => {
  const memberId = '2b7c2b87-1866-4a3f-b520-7c57e4d288a4';
  assert.equal(
    getDueDiligenceReferenceLabel({
      memberId,
      formValues: {
        organization_name: memberId,
        company_name: '4f3c2d91-2b77-4af5-a9cc-7bb2f9ddc8b7',
      },
      applicationUid: 'DD-123',
    }),
    'DD-123',
  );
});

test('DD application references may contain a UUID while unresolved field UUIDs are rejected', () => {
  assert.equal(
    getDueDiligenceReferenceLabel({
      memberId: 'deleted-member',
      formValues: { organization_name: 'deleted-member' },
      applicationUid: 'DD-5f14a2b9-4d6e-4011-821e-23d7e90385df',
    }),
    'DD-5f14a2b9-4d6e-4011-821e-23d7e90385df',
  );
});

test('unresolved relationship UUIDs are rejected even when not a known source ID', () => {
  assert.equal(
    getDueDiligenceReferenceLabel({
      cardReferenceField: 'contact',
      configuredValue: '4f3c2d91-2b77-4af5-a9cc-7bb2f9ddc8b7',
      formValues: { name: 'DD-456' },
      applicationUid: 'DD-456',
    }),
    'DD-456',
  );
});

test('organisation-only submissions preserve configured organisation labels', () => {
  assert.equal(
    getDueDiligenceReferenceLabel({
      organizationId: 'org-1',
      organization: { id: 'org-1', name: 'Organisation Label' },
      cardReferenceField: '__organization_name__',
    }),
    'Organisation Label',
  );
});

test('reference IDs remain typed independently', () => {
  const memberId = 'member-1';
  const organizationId = 'org-1';
  assert.equal(
    getDueDiligenceMemberId({ created_member_id: memberId, organization_id: organizationId }),
    memberId,
  );
  assert.equal(
    getDueDiligenceOrganizationId({ created_member_id: memberId, organization_id: organizationId }),
    organizationId,
  );
});
