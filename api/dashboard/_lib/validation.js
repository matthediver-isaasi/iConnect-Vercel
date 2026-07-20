import { z } from 'zod';

const fieldRefSchema = z.object({
  field: z.string().nullable().optional(),
  fieldKind: z.enum(['system', 'custom']).nullable().optional(),
  fieldId: z.string().nullable().optional(),
}).passthrough();

const filterSchema = z.object({
  field: z.string().nullable().optional(),
  fieldKind: z.enum(['system', 'custom']),
  fieldId: z.string().nullable().optional(),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null', 'is_not_null', 'lmic']),
  value: z.any().optional(),
  // DD-only: when filtering on the synthetic "Date moved to stage …" field,
  // carries the canonical DD status whose entry timestamp is being scoped.
  stage: z.string().nullable().optional(),
});

// Optional secondary field references for additive measures. When the
// aggregator is `sum`, the engine computes a per-row total of the
// primary field plus every additionalFields entry's value before
// applying the aggregator. This is how "Children Impacted (direct +
// indirect)" combines two custom numeric fields into one stat without
// a bespoke aggregator.
const additionalFieldRefSchema = z.object({
  field: z.string().nullable().optional(),
  fieldKind: z.enum(['system', 'custom']),
  fieldId: z.string().nullable().optional(),
});

const measureSchema = z.object({
  aggregator: z.enum(['count', 'count_distinct', 'sum', 'avg', 'min', 'max']),
  field: z.string().nullable().optional(),
  fieldKind: z.enum(['system', 'custom']).nullable().optional(),
  fieldId: z.string().nullable().optional(),
  additionalFields: z.array(additionalFieldRefSchema).nullable().optional(),
});

const timeBucketSchema = z.object({
  field: z.string(),
  granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']),
  // Optional kind/id pair so widgets can bucket on a custom date field
  // (resolved server-side via the preference store) in addition to system
  // date columns. Omitting fieldKind defaults to 'system' for backwards
  // compatibility with existing widgets.
  fieldKind: z.enum(['system', 'custom']).nullable().optional(),
  fieldId: z.string().nullable().optional(),
  // DD-only: when the bucket field is the synthetic "Date moved to stage …"
  // field, carries the canonical DD status whose entry timestamp is bucketed.
  stage: z.string().nullable().optional(),
});

const groupBySchema = z.object({
  kind: z.enum(['system', 'custom']),
  field: z.string().nullable().optional(),
  fieldId: z.string().nullable().optional(),
});

// DD stage-transition mode. When present (with a `mode`), the Due Diligence
// aggregator counts `status_changed` history events instead of current-status
// rows. `breakdown` produces one count per "From → To" pair (bar chart);
// `single` produces one count for a chosen From/To pair (stat/KPI). Stage
// values are canonical DD status labels (e.g. "New", "Verified").
const transitionSchema = z.object({
  mode: z.enum(['breakdown', 'single']),
  fromStage: z.string().nullable().optional(),
  toStage: z.string().nullable().optional(),
});

// Stat/KPI display-only formatting. Absent/null keeps the legacy compact
// style (e.g. 1.5M). `mode: 'full'` renders the exact value with locale
// thousands separators and `decimals` fraction digits (0–4, default 0).
const numberFormatSchema = z.object({
  mode: z.enum(['compact', 'full']),
  decimals: z.number().int().min(0).max(4).nullable().optional(),
});

// Form-conversion widgets (source `form_conversion`): admin picks a source
// form and a target form plus how submissions are matched — by the
// submission's organisation, or by the submitter's (lowercased) email.
const conversionSchema = z.object({
  sourceFormId: z.string().min(1),
  targetFormId: z.string().min(1),
  matchBy: z.enum(['organization', 'member']),
});

export const widgetConfigSchema = z.object({
  source: z.string(),
  measure: measureSchema,
  groupBy: groupBySchema.nullable().optional(),
  timeBucket: timeBucketSchema.nullable().optional(),
  // When true, time-bucketed line charts plot a running total across
  // buckets (each point = its own aggregate + all earlier buckets)
  // instead of the per-bucket value. Defaults to off; ignored for
  // scalar and grouped widgets.
  cumulative: z.boolean().optional(),
  // DD-only: present (with a mode) to switch the Due Diligence aggregator
  // into stage-transition counting. Null/absent for every other widget.
  transition: transitionSchema.nullable().optional(),
  // Stat/KPI-only display formatting; null/absent = legacy compact style.
  numberFormat: numberFormatSchema.nullable().optional(),
  filters: z.array(filterSchema).default([]),
  // Form-conversion only: required when source === 'form_conversion',
  // ignored (should be null/absent) for every other source.
  conversion: conversionSchema.nullable().optional(),
}).passthrough().superRefine((cfg, ctx) => {
  if (cfg.source === 'form_conversion') {
    if (!cfg.conversion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conversion'],
        message: 'Form conversion widgets need a source form, target form and match-by setting.',
      });
      return;
    }
    if (cfg.conversion.sourceFormId === cfg.conversion.targetFormId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['conversion', 'targetFormId'],
        message: 'Source and target forms must be different.',
      });
    }
  }
});

// `fifth` (col-span-2 on a 12-col grid) gives a five-card top row of
// KPI stats. Widths form a cycle in WidgetCard (fifth → third → half →
// full → fifth) so admins can resize through every option.
const widthEnum = z.enum(['fifth', 'third', 'half', 'full']);

export const widgetCreateSchema = z.object({
  title: z.string().min(1).max(200),
  widget_type: z.enum(['stat', 'bar', 'pie', 'donut', 'line', 'list']),
  scope: z.enum(['shared', 'personal']),
  width: widthEnum.default('third'),
  config: widgetConfigSchema,
});

export const widgetUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  widget_type: z.enum(['stat', 'bar', 'pie', 'donut', 'line', 'list']).optional(),
  width: widthEnum.optional(),
  config: widgetConfigSchema.optional(),
});

export const reorderSchema = z.object({
  scope: z.enum(['shared', 'personal']),
  ids: z.array(z.string()).min(1),
});
