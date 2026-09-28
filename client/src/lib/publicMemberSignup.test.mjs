import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canUsePublicMemberSignup,
  memberOwnerRequired,
  memberSignupLoginUrl,
  PUBLIC_MEMBER_SIGNUP_MODE,
} from './publicMemberSignup.js';

const memberForm = {
  require_authentication: false,
  entity_pipelines: {
    members: [{
      id: 'signup',
      uniqueness_key: 'email',
      mappings: [
        { target_type: 'core', target_field: 'email', source_field_id: 'email' },
        { target_type: 'core', target_field: 'first_name', source_field_id: 'name' },
      ],
    }],
    organisations: [],
  },
  fields: [{ id: 'email', type: 'email' }, { id: 'name', type: 'text' }],
};

test('builder offers public member signup for only the shared valid contract', () => {
  assert.equal(PUBLIC_MEMBER_SIGNUP_MODE, 'public_member_signup');
  assert.equal(canUsePublicMemberSignup(memberForm), true);
  assert.equal(canUsePublicMemberSignup({ ...memberForm, require_authentication: true }), false);
  assert.equal(canUsePublicMemberSignup({
    ...memberForm,
    entity_pipelines: {
      ...memberForm.entity_pipelines,
      organisations: [{
        id: 'org',
        mappings: [
          { target_type: 'core', target_field: 'name', source_field_id: 'name' },
          { target_type: 'core', target_field: 'website', source_field_id: 'name' },
        ],
      }],
    },
  }), false);
  assert.equal(canUsePublicMemberSignup({
    ...memberForm,
    structured_actions: [{ operation: 'update', entity_type: 'member' }],
  }), false);
  assert.equal(canUsePublicMemberSignup({ require_authentication: false }), false);
});

test('sign-in return URL preserves draft without taking a respondent-supplied redirect', () => {
  assert.equal(
    memberSignupLoginUrl({ pathname: '/FormView', search: '?slug=join&draft=opaque', hash: '#step' }),
    '/login?returnTo=%2FFormView%3Fslug%3Djoin%26draft%3Dopaque%23step',
  );
  assert.equal(memberSignupLoginUrl({ pathname: '//elsewhere', search: '' }), '/login?returnTo=%2F');
});

test('only stable owner-required error code triggers verified-owner guidance', () => {
  assert.equal(memberOwnerRequired({ errorData: { code: 'FORM_MEMBER_OWNER_REQUIRED' } }), true);
  assert.equal(memberOwnerRequired({ errorData: { error: { code: 'FORM_MEMBER_OWNER_REQUIRED' } } }), true);
  assert.equal(memberOwnerRequired({ message: 'FORM_MEMBER_OWNER_REQUIRED' }), false);
  assert.equal(memberOwnerRequired({ errorData: { code: 'UNSAFE_EXISTING_RECORD_MUTATION_CONTRACT' } }), false);
});

test('builder and both public layouts wire guidance and owner errors', async () => {
  const [builder, view] = await Promise.all([
    readFile(new URL('../pages/FormBuilder.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../pages/FormView.jsx', import.meta.url), 'utf8'),
  ]);
  assert.match(builder, /value=\{PUBLIC_MEMBER_SIGNUP_MODE\}[\s\S]*?disabled=\{!publicMemberSignupEligible\}/);
  assert.match(builder, /mutation_access_policy: mode === 'none'[\s\S]*?\{ version: 1, mode \}/);
  assert.equal((view.match(/<PublicMemberSignupNotice loginUrl=/g) || []).length, 2);
  assert.match(view, /setSubmissionError\(memberOwnerRequired\(error\)/);
  assert.match(view, /If you have unsaved answers, save a draft/);
});