import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import test from 'node:test';
import EventCapacitySummary from './EventCapacitySummary.jsx';

const render = props => renderToStaticMarkup(<EventCapacitySummary {...props} />).replace(/<[^>]+>/g,'');
test('editor preview distinguishes total from actual bookings and remaining', () => {
  assert.match(render({booked:118,commercial:0,used:118,total:146}),/Booked: 118 · Other committed places: 0 · Remaining: 28/);
  assert.match(render({booked:118,commercial:2,used:120,total:146}),/Remaining: 26/);
  assert.match(render({booked:118,commercial:0,used:118,total:100}),/Remaining: 0.*below current usage/);
  assert.match(render({booked:118,commercial:0,used:118,total:0}),/Remaining: 0.*No additional places/);
  assert.match(render({booked:118,commercial:0,used:118,unlimited:true}),/Remaining: Unlimited/);
  assert.match(render({total:146}),/Booked: Unavailable.*Remaining: Unavailable/);
  assert.match(render({used:118,total:''}),/Remaining: Unavailable/);
});
