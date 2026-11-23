import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL(file, import.meta.url),'utf8');
test('dedicated funnel page is routed, registered and uses existing create-event access', () => {
  const routes = read('./index.jsx'), layout = read('./Layout.jsx');
  assert.match(routes,/const EventFunnels = lazy/);
  assert.match(routes,/EventFunnels: EventFunnels/);
  assert.match(routes,/<Route path="\/EventFunnels" element={<EventFunnels \/>}/);
  assert.match(layout,/adminPages\.push\("EventFunnels"\)/);
  assert.match(layout,/'EventFunnels': 'events\.browse-events\.create'/);
  assert.match(layout,/title: "Event Funnels"[\s\S]{0,150}featureId: "events\.browse-events\.create"/);
  assert.match(read('./EventFunnels.jsx'),/<EventFunnelSettings standalone/);
});
test('event settings links to the separate workspace rather than embedding the editor', () => {
  const settings = read('./EventSettings.jsx');
  assert.doesNotMatch(settings,/<EventFunnelSettings/);
  assert.match(settings,/to="\/EventFunnels"/);
});
