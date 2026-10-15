import test from 'node:test';
import assert from 'node:assert/strict';
import {cpdEventChoices} from './cpdPointsReplay.js';
test('event search labels contain names and UK dates, not UUIDs',()=>{
  const [choice]=cpdEventChoices([{id:'hidden-id',title:'Webinar',start_date:'2026-10-13T12:00:00Z',source:'event'}]);
  assert.equal(choice.label,'Webinar · 13/10/2026 · Simple event');
  assert.equal(choice.searchText,choice.label);
  assert.equal(choice.value,'simple:hidden-id');
});
test('same-title events retain distinct source-aware identities',()=>{
  const choices=cpdEventChoices([{id:'one',title:'Same',source:'event'},
    {id:'one',title:'Same',source:'complex_event'},{id:'two',title:'Same',source:'event'}]);
  assert.equal(new Set(choices.map(c=>c.key)).size,3);
  assert.match(choices[1].label,/Multi-session/);
});
test('missing dates and titles have readable fallbacks',()=>{
  assert.match(cpdEventChoices([{id:'one'}])[0].label,/Untitled event · No date/);
});
