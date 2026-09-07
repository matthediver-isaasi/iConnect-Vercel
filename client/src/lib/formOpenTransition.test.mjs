import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOpenFormRule,
  firstMatchingOpenFormAction,
} from './formOpenTransition.js';
import { ruleMatches as serverRuleMatches } from '../../../api/public/form-transition.js';
import { FORM_NO_RELATIONSHIP_VALUE } from '../../../shared/formNoRelationshipChoice.js';

const openAction = {
  id: 'open-next',
  action_type: 'open_form',
  destination_form_id: 'destination',
};

test('legacy relationship-empty rules select and pass the same action client and server', () => {
  const form = {
    fields: [{ id: 'relationship', type: 'relationship_dropdown' }],
    visibility_rules: [{
      trigger_field_id: 'relationship',
      operator: 'equals',
      value: FORM_NO_RELATIONSHIP_VALUE,
      actions: [openAction],
    }],
  };
  const answers = { relationship: FORM_NO_RELATIONSHIP_VALUE };
  assert.equal(firstMatchingOpenFormAction(form, answers)?.id, openAction.id);
  assert.equal(serverRuleMatches(form, answers, form.visibility_rules[0], []), true);
});

test('multi-condition relationship-empty rules preserve AND semantics client and server', () => {
  const rule = {
    logic: 'and',
    conditions: [
      {
        field_id: 'relationship',
        operator: 'equals',
        value: FORM_NO_RELATIONSHIP_VALUE,
      },
      { field_id: 'consent', operator: 'equals', value: true },
    ],
    actions: [openAction],
  };
  const form = { visibility_rules: [rule] };
  const matching = { relationship: FORM_NO_RELATIONSHIP_VALUE, consent: true };
  const notMatching = { relationship: FORM_NO_RELATIONSHIP_VALUE, consent: false };
  assert.equal(evaluateOpenFormRule(form, matching, rule), true);
  assert.equal(serverRuleMatches(form, matching, rule, []), true);
  assert.equal(evaluateOpenFormRule(form, notMatching, rule), false);
  assert.equal(serverRuleMatches(form, notMatching, rule, []), false);
});

test('relationship sentinel does not satisfy ordinary empty rules accidentally', () => {
  const rule = {
    trigger_field_id: 'relationship',
    operator: 'equals',
    value: 'some-record',
    actions: [openAction],
  };
  const answers = { relationship: FORM_NO_RELATIONSHIP_VALUE };
  assert.equal(evaluateOpenFormRule({}, answers, rule), false);
  assert.equal(serverRuleMatches({}, answers, rule, []), false);
});

test('legacy ISO country answers compare as country names on client and server', () => {
  const rule = {
    trigger_field_id: 'country',
    operator: 'equals',
    value: 'Spain',
    actions: [openAction],
  };
  const answers = { country: 'ES' };
  assert.equal(evaluateOpenFormRule({}, answers, rule), true);
  assert.equal(serverRuleMatches({}, answers, rule, []), true);
});