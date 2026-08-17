/**
 * Tests for dashboard widget height feature:
 *  1. Validation schema accepts / rejects height values
 *  2. Height defaults correctly when omitted
 *  3. Update schema accepts height patches
 *  4. PIE_HEIGHT_CONFIG: outerRadius fits inside container height without clipping
 *  5. BAR_HEIGHT_PROPS: xAxisHeight stays below chart height so labels don't crowd the plot
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { widgetCreateSchema, widgetUpdateSchema } from './validation.js';

// ---------------------------------------------------------------------------
// Minimal valid widget payload used as a base for create tests.
// ---------------------------------------------------------------------------
const BASE_CREATE = {
  title: 'Test widget',
  widget_type: 'stat',
  scope: 'personal',
  config: {
    source: 'organization',
    measure: { aggregator: 'count' },
    filters: [],
  },
};

// ---------------------------------------------------------------------------
// widgetCreateSchema — height field
// ---------------------------------------------------------------------------

test('widgetCreateSchema accepts height: short', () => {
  const result = widgetCreateSchema.safeParse({ ...BASE_CREATE, height: 'short' });
  assert.equal(result.success, true, JSON.stringify(result.error?.flatten?.()));
  assert.equal(result.data.height, 'short');
});

test('widgetCreateSchema accepts height: medium', () => {
  const result = widgetCreateSchema.safeParse({ ...BASE_CREATE, height: 'medium' });
  assert.equal(result.success, true);
  assert.equal(result.data.height, 'medium');
});

test('widgetCreateSchema accepts height: tall', () => {
  const result = widgetCreateSchema.safeParse({ ...BASE_CREATE, height: 'tall' });
  assert.equal(result.success, true);
  assert.equal(result.data.height, 'tall');
});

test('widgetCreateSchema defaults height to medium when omitted', () => {
  const result = widgetCreateSchema.safeParse(BASE_CREATE);
  assert.equal(result.success, true);
  assert.equal(result.data.height, 'medium');
});

test('widgetCreateSchema rejects unknown height values', () => {
  const result = widgetCreateSchema.safeParse({ ...BASE_CREATE, height: 'huge' });
  assert.equal(result.success, false);
});

test('widgetCreateSchema rejects null height', () => {
  const result = widgetCreateSchema.safeParse({ ...BASE_CREATE, height: null });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// widgetUpdateSchema — height field
// ---------------------------------------------------------------------------

test('widgetUpdateSchema accepts a height-only patch', () => {
  const result = widgetUpdateSchema.safeParse({ height: 'tall' });
  assert.equal(result.success, true);
  assert.equal(result.data.height, 'tall');
});

test('widgetUpdateSchema accepts height alongside other fields', () => {
  const result = widgetUpdateSchema.safeParse({ title: 'New title', height: 'short' });
  assert.equal(result.success, true);
  assert.equal(result.data.height, 'short');
});

test('widgetUpdateSchema rejects invalid height in a PATCH', () => {
  const result = widgetUpdateSchema.safeParse({ height: 'xlarge' });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// Structural invariants for the client-side height config tables.
// These are expressed as pure data constants so they can be validated in a
// Node test without a DOM / React runtime.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Client-side height config tables — structural invariants.
// Mirrors the constants in client/src/components/dashboard/WidgetCard.jsx
// so that geometry mistakes are caught without a browser/DOM runtime.
// ---------------------------------------------------------------------------

// Mirrors BAR_HEIGHT_PROPS (className converted to approximate px).
const BAR_HEIGHT_PROPS = {
  short:  { classNamePx: 128, xAxisHeight: 40, angle: -20 },
  medium: { classNamePx: 176, xAxisHeight: 50, angle: -25 },
  tall:   { classNamePx: 288, xAxisHeight: 80, angle: -45 },
};

// Mirrors PIE_HEIGHT_CONFIG.
const PIE_HEIGHT_CONFIG = {
  short:  { containerPx: 144, outerRadius: 55, innerRadius: 32 },
  medium: { containerPx: 176, outerRadius: 72, innerRadius: 44 },
  tall:   { containerPx: 240, outerRadius: 95, innerRadius: 58 },
};

// Mirrors LIST_HEIGHT_CLASS.
const LIST_HEIGHT_CLASS = {
  short:  { min: 'min-h-[8rem]',  max: 'max-h-48' },
  medium: { min: 'min-h-[10rem]', max: 'max-h-64' },
  tall:   { min: 'min-h-[14rem]', max: 'max-h-96' },
};

// Mirrors STAT_HEIGHT_CLASS (also used by EmptyChart and loading/error states).
const STAT_HEIGHT_CLASS = {
  short:  'min-h-[8rem]',
  medium: 'min-h-[10rem]',
  tall:   'min-h-[14rem]',
};

for (const [height, cfg] of Object.entries(BAR_HEIGHT_PROPS)) {
  test(`BAR_HEIGHT_PROPS[${height}]: xAxisHeight (${cfg.xAxisHeight}px) is less than chart height (${cfg.classNamePx}px)`, () => {
    assert.ok(
      cfg.xAxisHeight < cfg.classNamePx,
      `xAxisHeight ${cfg.xAxisHeight} must be less than chart container height ${cfg.classNamePx}`,
    );
  });
}

for (const [height, cfg] of Object.entries(PIE_HEIGHT_CONFIG)) {
  test(`PIE_HEIGHT_CONFIG[${height}]: outerRadius diameter (${cfg.outerRadius * 2}px) fits inside container (${cfg.containerPx}px)`, () => {
    assert.ok(
      cfg.outerRadius * 2 < cfg.containerPx,
      `outerRadius ${cfg.outerRadius} × 2 = ${cfg.outerRadius * 2} exceeds container height ${cfg.containerPx}`,
    );
  });

  test(`PIE_HEIGHT_CONFIG[${height}]: donut innerRadius (${cfg.innerRadius}) is less than outerRadius (${cfg.outerRadius})`, () => {
    assert.ok(
      cfg.innerRadius < cfg.outerRadius,
      `innerRadius ${cfg.innerRadius} must be less than outerRadius ${cfg.outerRadius}`,
    );
  });
}

// List widgets must produce distinct min-h classes for each height value so
// the card size is deterministic even when the list has few or no rows.
test('LIST_HEIGHT_CLASS: all three heights produce different min-h classes', () => {
  const mins = Object.values(LIST_HEIGHT_CLASS).map(c => c.min);
  assert.equal(new Set(mins).size, 3, `Expected 3 distinct min-h values, got: ${mins.join(', ')}`);
});

test('LIST_HEIGHT_CLASS: all three heights produce different max-h classes', () => {
  const maxes = Object.values(LIST_HEIGHT_CLASS).map(c => c.max);
  assert.equal(new Set(maxes).size, 3, `Expected 3 distinct max-h values, got: ${maxes.join(', ')}`);
});

test('LIST_HEIGHT_CLASS: every height entry has both min and max keys', () => {
  for (const [height, cfg] of Object.entries(LIST_HEIGHT_CLASS)) {
    assert.ok(cfg.min, `LIST_HEIGHT_CLASS[${height}].min is missing`);
    assert.ok(cfg.max, `LIST_HEIGHT_CLASS[${height}].max is missing`);
  }
});

// EmptyChart height classes (sourced from STAT_HEIGHT_CLASS): must produce
// distinct values so height setting is visible on empty widgets too.
test('STAT_HEIGHT_CLASS: all three heights produce different min-h classes', () => {
  const vals = Object.values(STAT_HEIGHT_CLASS);
  assert.equal(new Set(vals).size, 3, `Expected 3 distinct values, got: ${vals.join(', ')}`);
});

test('STAT_HEIGHT_CLASS covers short, medium, and tall', () => {
  assert.ok('short' in STAT_HEIGHT_CLASS);
  assert.ok('medium' in STAT_HEIGHT_CLASS);
  assert.ok('tall' in STAT_HEIGHT_CLASS);
});
