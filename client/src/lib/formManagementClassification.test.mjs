import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  getFormLayoutClassification,
  isEventLinkedForm,
  isSurveyForm,
  matchesFormClassification,
} from './formManagementClassification.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const managementSource = readFileSync(path.join(here, '../pages/FormManagement.jsx'), 'utf8');

test('classifies the two existing layouts independently of form characteristics', () => {
  const survey = { form_type: 'survey', is_event_related: true };
  const cardSwipeSurvey = { ...survey, layout_type: 'card_swipe' };

  assert.equal(getFormLayoutClassification(survey), 'standard');
  assert.equal(getFormLayoutClassification(cardSwipeSurvey), 'card_swipe');
  assert.equal(matchesFormClassification(survey, 'standard'), true);
  assert.equal(matchesFormClassification(cardSwipeSurvey, 'card_swipe'), true);
});

test('identifies survey forms from the persisted form type', () => {
  assert.equal(isSurveyForm({ form_type: 'survey' }), true);
  assert.equal(isSurveyForm({ form_type: 'standard' }), false);
  assert.equal(matchesFormClassification({ form_type: 'survey' }, 'survey'), true);
});

test('identifies event-linked forms from their event-related configuration', () => {
  assert.equal(isEventLinkedForm({ is_event_related: true }), true);
  assert.equal(isEventLinkedForm({ is_event_related: false, related_event_id: 'event-1' }), false);
  assert.equal(matchesFormClassification({ is_event_related: true }, 'event_linked'), true);
});

test('allows survey and event-linked characteristics to overlap', () => {
  const form = {
    form_type: 'survey',
    is_event_related: true,
    layout_type: 'card_swipe',
  };

  assert.equal(isSurveyForm(form), true);
  assert.equal(isEventLinkedForm(form), true);
  assert.equal(matchesFormClassification(form, 'survey'), true);
  assert.equal(matchesFormClassification(form, 'event_linked'), true);
  assert.equal(matchesFormClassification(form, 'card_swipe'), true);
});

test('all and unknown classifications do not exclude forms', () => {
  assert.equal(matchesFormClassification({}, 'all'), true);
  assert.equal(matchesFormClassification({}, 'future_value'), true);
});

test('management filter exposes survey and event-linked choices', () => {
  assert.match(managementSource, /<SelectItem value="survey">Survey<\/SelectItem>/);
  assert.match(managementSource, /<SelectItem value="event_linked">Event Linked<\/SelectItem>/);
  assert.match(managementSource, /matchesFormClassification\(form, standardFilters\.layout\)/);
});

test('card and list views render both characteristic badges only for non-contract forms', () => {
  assert.match(managementSource, /badge-survey-\$\{form\.id\}/);
  assert.match(managementSource, /badge-event-linked-\$\{form\.id\}/);
  assert.match(managementSource, /badge-survey-row-\$\{form\.id\}/);
  assert.match(managementSource, /badge-event-linked-row-\$\{form\.id\}/);

  const cardContractBranch = managementSource.indexOf('{isContract ? (');
  const cardSurveyBadge = managementSource.indexOf('badge-survey-${form.id}');
  const rowContractBranch = managementSource.indexOf('{isContract ? (', cardContractBranch + 1);
  const rowSurveyBadge = managementSource.indexOf('badge-survey-row-${form.id}');
  assert.ok(cardContractBranch < cardSurveyBadge);
  assert.ok(rowContractBranch < rowSurveyBadge);
});