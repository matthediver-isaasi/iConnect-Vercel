import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fixture, now } from './fixtures/training-reminders.mjs';
import { trainingReminderTargets } from '../api/_lib/trainingReminderTargets.js';

let script;
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import EventEmailSettingsEditor from './client/src/components/events/EventEmailSettingsEditor.jsx';
      function App() {
        const [emails,setEmails] = useState(window.fixtureEmails);
        return <EventEmailSettingsEditor emails={emails} setEmails={setEmails} emailTemplates={[]} eventId="event" />;
      }
      createRoot(document.getElementById('root')).render(<App />);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture', setup(b) {
      b.onResolve({ filter: /CampaignEventSurveySettings$/ }, () => ({ path: 'survey', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default () => null;' }));
      b.onResolve({ filter: /^@\// }, args => {
        const base = path.resolve('client/src', args.path.slice(2));
        return { path: [base, `${base}.jsx`, `${base}.js`, `${base}.tsx`, `${base}.ts`].find(p => existsSync(p)) || base };
      });
      b.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
    } }],
  });
  script = result.outputFiles[0].text;
});

test('draft preview defaults upcoming, selects another entry and explains elapsed windows without writes', async ({ page }) => {
  const data = fixture(), calls = [], errors = [];
  let clock = now;
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'training-reminders.test') return route.abort();
    if (url.pathname === '/api/event-emails/event/preview') {
      const body = route.request().postDataJSON();
      calls.push(body);
      const calc = trainingReminderTargets(data.event[0], body.reminder, data.event_agenda_item, clock);
      const selected = body.sessionId ? calc.eligible.find(t => t.sessionId === body.sessionId) : calc.eligible[0];
      return route.fulfill({ json: {
        subject: selected ? `Session ${selected.line.start_date} 09:15` : '', html: '<p>Sample reminder</p>',
        reminderContext: { timezone: calc.timezone, selectedId: selected?.sessionId, sendAt: selected?.scheduledTime.toISOString(),
          entries: calc.eligible.map(t => ({ id: t.sessionId, sessionDate: t.anchor.toISOString(), description: t.line.item_type })),
          emptyReason: !selected ? 'No eligible future reminder. Elapsed reminder times are not caught up.' : null },
      } });
    }
    if (url.pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
  });
  await page.goto('/');
  await page.evaluate(emails => { window.fixtureEmails = emails; }, data.event_email);
  await page.addScriptTag({ content: script });
  await page.getByTestId('button-preview-email-email').click();
  await expect(page.getByText(/Unsaved draft with sample/)).toBeVisible();
  await expect(page.getByLabel('Training agenda entry')).toHaveValue('nov3');
  await expect(page.getByText(/Intended send time:/)).toContainText('02/11/2026, 09:15');
  await page.getByLabel('Training agenda entry').selectOption('nov5');
  await expect(page.getByTestId('email-preview-subject')).toContainText('2026-11-05 09:15');
  await expect(page.getByText(/Intended send time:/)).toContainText('04/11/2026, 09:15');
  await page.screenshot({ path: '/tmp/training-reminder-preview.png' });
  clock = new Date('2026-11-06T12:00Z');
  await page.getByLabel('Training agenda entry').selectOption('nov3');
  await expect(page.getByRole('status')).toContainText('No eligible future reminder');
  expect(calls).toHaveLength(3);
  expect(errors).toEqual([]);
});
