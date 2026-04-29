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
});

const groupBySchema = z.object({
  kind: z.enum(['system', 'custom']),
  field: z.string().nullable().optional(),
  fieldId: z.string().nullable().optional(),
});

export const widgetConfigSchema = z.object({
  source: z.string(),
  measure: measureSchema,
  groupBy: groupBySchema.nullable().optional(),
  timeBucket: timeBucketSchema.nullable().optional(),
  filters: z.array(filterSchema).default([]),
}).passthrough();

// `fifth` (col-span-2 on a 12-col grid) gives a five-card top row of
// KPI stats. Widths form a cycle in WidgetCard (fifth → third → half →
// full → fifth) so admins can resize through every option.
const widthEnum = z.enum(['fifth', 'third', 'half', 'full']);

export const widgetCreateSchema = z.object({
  title: z.string().min(1).max(200),
  widget_type: z.enum(['stat', 'bar', 'pie', 'donut', 'line']),
  scope: z.enum(['shared', 'personal']),
  width: widthEnum.default('third'),
  config: widgetConfigSchema,
});

export const widgetUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  widget_type: z.enum(['stat', 'bar', 'pie', 'donut', 'line']).optional(),
  width: widthEnum.optional(),
  config: widgetConfigSchema.optional(),
});

export const reorderSchema = z.object({
  scope: z.enum(['shared', 'personal']),
  ids: z.array(z.string()).min(1),
});
