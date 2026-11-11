import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the actual schedule JSX without loading authenticated queries or Zoom APIs.
const source = readFileSync(new URL('./EditEvent.jsx', import.meta.url), 'utf8');
const declaration = source.match(/const zoomTimeHelperText = .*;/)?.[0];
assert.ok(declaration, 'shared label declaration exists');
const start = source.indexOf('{!isImmediate && (');
const end = source.indexOf('{/* Timezone selector/indicator */}', start);
assert.ok(start >= 0 && end > start, 'schedule section exists');
const section = source.slice(start, end);
const compiled = transformSync(`
  import React from 'react';
  const Label = ({children}) => <label>{children}</label>;
  const TimezoneAwareDateTimeInput = ({value, disabled, id}) => <input id={id} value={value} disabled={disabled} readOnly />;
  export default function Schedule({event, isTraining = false, isOnlineEvent = true,
    isGroupLimited = false, eventTiming = 'published', isImmediate = false,
    isTimezoneLoading = false}) {
    ${declaration}
    const eventTimezone = 'Europe/London';
    const formData = {start_date: '2026-11-11T10:00', end_date: '2026-11-11T11:00'};
    const trainingDerivedDates = {start: formData.start_date, end: formData.end_date, errors: []};
    const handleInputChange = () => {};
    return <>${section}</>)}</>;
  }
`, { loader: 'jsx', format: 'cjs' });
const mod = new Module(import.meta.filename);
mod.paths = Module._nodeModulePaths(process.cwd());
mod._compile(compiled.code, import.meta.filename);
const render = (props) => renderToStaticMarkup(React.createElement(mod.exports.default, props));

for (const [name, event, label] of [
  ['meeting', {zoom_meeting_id: 'meeting'}, 'meeting'],
  ['webinar', {zoom_webinar_id: 'webinar'}, 'webinar'],
  ['both IDs preserve meeting precedence', {zoom_meeting_id: 'meeting', zoom_webinar_id: 'webinar'}, 'meeting'],
  ['unlinked preserves webinar fallback', {}, 'webinar'],
  ['loading event preserves webinar fallback', undefined, 'webinar'],
]) {
  test(`${name}: both time inputs share the label`, () => {
    const html = render({event});
    assert.equal(html.match(new RegExp(`Managed by Zoom ${label}`, 'g'))?.length, 2);
    assert.match(html, /value="2026-11-11T10:00"/);
    assert.match(html, /value="2026-11-11T11:00"/);
    assert.equal(html.match(/disabled=""/g)?.length, 2);
  });
}

for (const event of [{zoom_meeting_id: 'meeting'}, {zoom_webinar_id: 'webinar'}]) {
  for (const [state, props] of [
    ['training', {isTraining: true}],
    ['offline', {isOnlineEvent: false}],
    ['group-limited', {isGroupLimited: true}],
    ['TBC', {eventTiming: 'tbc'}],
    ['immediate', {isImmediate: true}],
  ]) {
    test(`${Object.keys(event)[0]}: helper stays hidden for ${state}`, () => {
      const html = render({event, ...props});
      assert.doesNotMatch(html, /Managed by Zoom/);
      if (state === 'immediate') assert.doesNotMatch(html, /<input/);
      if (state === 'offline' || state === 'group-limited') assert.doesNotMatch(html, /disabled=""/);
    });
  }
}
