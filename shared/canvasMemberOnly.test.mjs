import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MEMBER_ONLY_GUEST_MESSAGE,
  MEMBER_ONLY_GUEST_MESSAGE_MAX_LENGTH,
  normalizeMemberOnlyContent,
  normalizeMemberOnlyFields,
  normalizeMemberOnlyGuestMessage,
  projectCanvasDesignForGuest,
  projectMemberOnlyGuest,
} from './canvasMemberOnly.js';

function designWith(block) {
  return {
    version: 1,
    root: {
      sections: [{ id: 'section', children: [block] }],
    },
  };
}

test('guest message is plain text, decoded, defaulted, and bounded', () => {
  assert.equal(
    normalizeMemberOnlyGuestMessage(' <strong>Hello&nbsp;member</strong> '),
    'Hello member'
  );
  assert.equal(
    normalizeMemberOnlyGuestMessage('<script>alert(1)</script>'),
    DEFAULT_MEMBER_ONLY_GUEST_MESSAGE
  );
  const result = normalizeMemberOnlyGuestMessage('x'.repeat(700));
  assert.equal(result.length, MEMBER_ONLY_GUEST_MESSAGE_MAX_LENGTH);
  assert.equal(result, 'x'.repeat(MEMBER_ONLY_GUEST_MESSAGE_MAX_LENGTH));
});

test('authoring contract always carries a boolean and bounded guest message', () => {
  const normalized = normalizeMemberOnlyContent({
    html: '<p>secret</p>',
    memberOnly: 1,
    guestMessage: '<em>Join us</em>',
  });
  assert.equal(normalized.memberOnly, false);
  assert.equal(normalized.guestMessage, 'Join us');
});

test('guest projection removes protected html and marks the redacted content', () => {
  const source = designWith({
    id: 'secret',
    type: 'custom-html',
    content: {
      html: '<p>TOP SECRET</p>',
      memberOnly: true,
      guestMessage: '<strong>Sign in</strong>',
    },
  });
  const projected = projectCanvasDesignForGuest(source);
  const content = projected.root.sections[0].children[0].content;
  assert.equal('html' in content, false);
  assert.equal(content.memberOnly, true);
  assert.equal(content.memberOnlyRedacted, true);
  assert.equal(content.guestMessage, 'Sign in');
  assert.equal(JSON.stringify(projected).includes('TOP SECRET'), false);
  assert.equal(source.root.sections[0].children[0].content.html, '<p>TOP SECRET</p>');
});

test('projection recurses through arbitrary nested blocks and arrays', () => {
  const source = {
    outer: {
      children: [{
        type: 'row',
        content: {
          items: [{
            type: 'custom-html',
            content: { html: 'nested secret', memberOnly: true },
          }],
        },
      }],
      footer: {
        type: 'custom-html',
        content: { html: 'footer secret', memberOnly: true },
      },
    },
  };
  const projected = projectMemberOnlyGuest(source);
  assert.equal(projected.outer.children[0].content.items[0].content.html, undefined);
  assert.equal(projected.outer.footer.content.html, undefined);
  assert.equal(projected.outer.children[0].content.items[0].content.memberOnlyRedacted, true);
  assert.equal(projected.outer.footer.content.memberOnlyRedacted, true);
  assert.equal(JSON.stringify(projected).includes('secret'), false);
});

test('member projection preserves actual html while returning a detached value', () => {
  const source = designWith({
    type: 'custom-html',
    content: { html: '<p>member copy</p>', memberOnly: true },
  });
  const projected = projectMemberOnlyGuest(source, { allowMemberOnlyContent: true });
  assert.deepEqual(projected, source);
  assert.notEqual(projected, source);
  assert.notEqual(projected.root, source.root);
});

test('legacy and toggle-off blocks are unchanged apart from defensive cloning', () => {
  const source = designWith({
    type: 'custom-html',
    content: { html: '<p>public copy</p>', memberOnly: false },
  });
  assert.deepEqual(projectCanvasDesignForGuest(source), source);
});

test('authoring normalization recurses without removing trusted html', () => {
  const normalized = normalizeMemberOnlyFields({
    nested: [{
      type: 'custom-html',
      content: { html: '<p>secret</p>', memberOnly: true, guestMessage: '<b>Join</b>' },
    }],
  });
  const content = normalized.nested[0].content;
  assert.equal(content.html, '<p>secret</p>');
  assert.equal(content.memberOnly, true);
  assert.equal(content.guestMessage, 'Join');
});
