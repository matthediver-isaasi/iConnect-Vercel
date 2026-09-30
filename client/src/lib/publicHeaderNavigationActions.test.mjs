import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEligiblePublicHeaderActions,
  getPublicHeaderActionDestination,
  getPublicHeaderButtonStyles,
  selectPublicHeaderAction,
} from './publicHeaderNavigationActions.js';

const internalJoin = {
  id: 'join',
  title: ' Join ',
  link_type: 'internal',
  url: 'Membership',
  display_type: 'button',
};

test('eligible actions include valid button destinations across nested public navigation', () => {
  const external = {
    id: 'external',
    title: 'Apply',
    link_type: 'external',
    url: 'https://example.test/apply',
    open_in_new_tab: true,
    display_type: 'button',
  };
  const form = {
    id: 'form',
    title: 'Enquire',
    link_type: 'form_modal',
    form_slug: 'enquire',
  };
  const actions = getEligiblePublicHeaderActions({
    topNav: [{ id: 'parent', title: 'Parent', children: [external] }],
    mainNav: [internalJoin, form, {
      id: 'plain',
      title: 'About',
      link_type: 'internal',
      url: 'About',
    }],
  });
  assert.deepEqual(actions.map((item) => item.id), ['external', 'join', 'form']);
});

test('auto resolution requires exactly one eligible Join button', () => {
  assert.equal(selectPublicHeaderAction([internalJoin]), internalJoin);
  assert.equal(selectPublicHeaderAction([
    internalJoin,
    { ...internalJoin, id: 'join-2', url: 'Other' },
  ]), null);
  assert.equal(selectPublicHeaderAction([
    { ...internalJoin, display_type: 'link' },
  ]), null);
});

test('explicit navigation id selects an eligible action and never falls back', () => {
  const apply = {
    id: 42,
    title: 'Apply',
    link_type: 'external',
    url: 'https://example.test',
    display_type: 'button',
  };
  assert.equal(
    selectPublicHeaderAction([internalJoin, apply], { navigationItemId: '42' }),
    apply,
  );
  assert.equal(
    selectPublicHeaderAction([internalJoin], { navigationItemId: 'missing' }),
    null,
  );
});

test('destination helper preserves internal, external and form behavior', () => {
  assert.deepEqual(getPublicHeaderActionDestination(internalJoin), {
    type: 'internal',
    page: 'Membership',
  });
  assert.deepEqual(getPublicHeaderActionDestination({
    link_type: 'external',
    link_url: 'https://example.test',
    open_in_new_tab: true,
  }), {
    type: 'external',
    href: 'https://example.test',
    target: '_blank',
    rel: 'noopener noreferrer',
  });
  assert.deepEqual(getPublicHeaderActionDestination({
    link_type: 'form_modal',
    form_slug: 'join-form',
  }), {
    type: 'form',
    formSlug: 'join-form',
  });
  assert.equal(getPublicHeaderActionDestination({
    link_type: 'form_modal',
    form_slug: '',
  }), null);
});

test('shared style resolver preserves configured normal and hover branding', () => {
  const styles = getPublicHeaderButtonStyles({
    background: {
      gradientAngle: 45,
      gradientStops: [
        { color: '#222222', position: 100 },
        { color: '#111111', position: 0 },
      ],
    },
    hover: { type: 'solid', solidColor: '#333333' },
    textColor: '#eeeeee',
    hoverTextColor: '#ffffff',
    radius: 7,
    border: { width: 2, style: 'dashed', color: '#444444' },
  });
  assert.deepEqual(styles.normal, {
    background: 'linear-gradient(45deg, #111111 0%, #222222 100%)',
    color: '#eeeeee',
    borderWidth: '2px',
    borderStyle: 'dashed',
    borderColor: '#444444',
    borderRadius: '7px',
  });
  assert.equal(styles.hover.background, '#333333');
  assert.equal(styles.hover.color, '#ffffff');
});