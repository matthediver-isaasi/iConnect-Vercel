import test from 'node:test';
import assert from 'node:assert/strict';
import { getSubmitterCopyMessage, renderSubmitterCopyMessage, defaultSubmitterCopyMessage } from './submitterCopyEmail.js';

test('existing forms and blank overrides retain the default', () => {
  for (const value of [undefined, null, '', '  ']) {
    assert.equal(getSubmitterCopyMessage({ submitter_copy_email_message: value }), defaultSubmitterCopyMessage());
  }
  assert.match(renderSubmitterCopyMessage({ name: 'Application' }, 'Institute'), /Application \(Institute\)/);
});

test('custom copy preserves paragraphs, escapes HTML and substitutes tokens once', () => {
  const html = renderSubmitterCopyMessage({
    name: '<Join>{{tenant_name}}',
    submitter_copy_email_message: 'Hello {{form_name}}\nNext line\n\n<script>bad</script> {{tenant_name}}',
  }, 'A&B');
  assert.equal(html, '<p>Hello &lt;Join&gt;{{tenant_name}}<br>Next line</p>\n<p>&lt;script&gt;bad&lt;/script&gt;  (A&amp;B)</p>');
});
