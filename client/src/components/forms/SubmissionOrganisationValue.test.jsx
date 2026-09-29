import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import SubmissionOrganisationValue from './SubmissionOrganisationValue.jsx';

const render = props => renderToStaticMarkup(<SubmissionOrganisationValue {...props} />);
test('saved organisation is displayed without a form or current dropdown options', () => {
  const html = render({ value: 'saved-org', namesById: { 'saved-org': 'University of Lancashire' } });
  assert.match(html, /University of Lancashire/);
  assert.doesNotMatch(html, /persisted form|saved-org|select/i);
});
test('loading and lookup failure are distinct from an absent answer', () => {
  assert.match(render({ value: 'saved-org', loading: true }), /Loading organisation/);
  assert.match(render({ value: 'saved-org', error: new Error('failed') }), /Unable to load organisation name/);
  assert.doesNotMatch(render({ value: 'saved-org', namesById: {} }), /saved-org|Not provided|persisted form/);
});