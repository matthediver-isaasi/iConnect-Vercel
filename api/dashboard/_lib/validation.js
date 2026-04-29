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
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_null', 'is_not_null']),
  value: z.any().optional(),
});

const measureSchema = z.object({
  aggregator: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  field: z.string().nullable().optional(),
  fieldKind: z.enum(['system', 'custom']).nullable().optional(),
  fieldId: z.string().nullable().optional(),
});

const timeBucketSchema = z.object({
  field: z.string(),
  granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']),
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

export const widgetCreateSchema = z.object({
  title: z.string().min(1).max(200),
  widget_type: z.enum(['stat', 'bar', 'pie', 'donut', 'line']),
  scope: z.enum(['shared', 'personal']),
  width: z.enum(['third', 'half', 'full']).default('third'),
  config: widgetConfigSchema,
});

export const widgetUpdateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  widget_type: z.enum(['stat', 'bar', 'pie', 'donut', 'line']).optional(),
  width: z.enum(['third', 'half', 'full']).optional(),
  config: widgetConfigSchema.optional(),
});

export const reorderSchema = z.object({
  scope: z.enum(['shared', 'personal']),
  ids: z.array(z.string()).min(1),
});
