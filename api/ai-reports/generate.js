import OpenAI from 'openai';
import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

const rateLimits = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60000;

let openaiClient = null;

function getOpenAIClient() {
  if (openaiClient) return openaiClient;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  openaiClient = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
  return openaiClient;
}

const TABLE_COLUMNS = {
  member: ['id', 'tenant_id', 'organization_id', 'role_id', 'first_name', 'last_name', 'email', 'phone', 'status', 'membership_type', 'created_date', 'last_login', 'job_title', 'department'],
  organization: ['id', 'tenant_id', 'name', 'org_type', 'status', 'email', 'phone', 'website', 'address_line_1', 'city', 'state', 'country', 'postcode', 'created_date'],
  event: ['id', 'tenant_id', 'title', 'description', 'event_type', 'start_date', 'end_date', 'location', 'status', 'max_attendees', 'is_virtual', 'created_date'],
  booking: ['id', 'organization_id', 'member_id', 'event_id', 'status', 'booking_date', 'number_of_attendees', 'created_date'],
  role: ['id', 'tenant_id', 'name', 'description'],
  form: ['id', 'tenant_id', 'title', 'description', 'status', 'form_type', 'created_date'],
  form_submission: ['id', 'tenant_id', 'form_id', 'member_id', 'status', 'submitted_date', 'created_date'],
  resource: ['id', 'tenant_id', 'title', 'description', 'resource_type', 'category_id', 'status', 'view_count', 'created_date'],
  job_posting: ['id', 'tenant_id', 'organization_id', 'title', 'description', 'location', 'job_type', 'status', 'salary_range', 'created_date', 'closing_date'],
  blog_post: ['id', 'tenant_id', 'title', 'status', 'category', 'author_id', 'view_count', 'published_date', 'created_date'],
  news_post: ['id', 'tenant_id', 'title', 'status', 'category', 'published_date', 'created_date'],
  article_view: ['id', 'tenant_id', 'article_id', 'user_identifier', 'is_member', 'created_date'],
  article_comment: ['id', 'tenant_id', 'article_id', 'author_member_id', 'user_identifier', 'is_member', 'created_date'],
  article_reaction: ['id', 'tenant_id', 'article_id', 'user_identifier', 'is_member', 'reaction_type', 'created_date'],
  support_ticket: ['id', 'tenant_id', 'member_id', 'subject', 'status', 'priority', 'category', 'created_date', 'resolved_date'],
  support_ticket_response: ['id', 'tenant_id', 'ticket_id', 'created_date'],
  program_ticket_transaction: ['id', 'tenant_id', 'organization_id', 'program_name', 'transaction_type', 'quantity', 'unit_price', 'total_cost_before_discount', 'original_quantity', 'cancelled_quantity', 'created_date'],
  voucher: ['id', 'tenant_id', 'code', 'status', 'value', 'created_date'],
  voucher_transaction: ['id', 'tenant_id', 'voucher_id', 'amount', 'created_date'],
  discount_code: ['id', 'tenant_id', 'code', 'discount_type', 'discount_value', 'status', 'created_date'],
  discount_code_usage: ['id', 'tenant_id', 'discount_code_id', 'member_id', 'created_date'],
  member_group: ['id', 'tenant_id', 'name', 'description', 'created_date'],
  member_group_assignment: ['id', 'tenant_id', 'member_group_id', 'member_id', 'created_date'],
  speaker: ['id', 'tenant_id', 'name', 'title', 'organization', 'created_date'],
  award: ['id', 'tenant_id', 'name', 'description', 'category', 'created_date'],
  training_fund_transaction: ['id', 'tenant_id', 'organization_id', 'amount', 'transaction_type', 'created_date'],
  workflow: ['id', 'tenant_id', 'name', 'status', 'trigger_type', 'created_date'],
  workflow_log: ['id', 'tenant_id', 'workflow_id', 'status', 'created_date'],
  email_template: ['id', 'tenant_id', 'name', 'subject', 'template_type', 'created_date'],
  resource_category: ['id', 'tenant_id', 'name', 'description', 'created_date'],
  resource_folder: ['id', 'tenant_id', 'name', 'parent_id', 'created_date'],
};

const ALLOWED_TABLES = Object.keys(TABLE_COLUMNS);

const ALLOWED_JOINS = {
  booking: {
    event: { foreignKey: 'event_id', columns: ['id', 'title', 'event_type', 'start_date', 'end_date', 'location', 'status'] },
    member: { foreignKey: 'member_id', columns: ['id', 'first_name', 'last_name', 'email', 'status'] },
    organization: { foreignKey: 'organization_id', columns: ['id', 'name', 'org_type', 'status'] },
  },
  member: {
    organization: { foreignKey: 'organization_id', columns: ['id', 'name', 'org_type', 'status'] },
    role: { foreignKey: 'role_id', columns: ['id', 'name', 'description'] },
  },
  form_submission: {
    form: { foreignKey: 'form_id', columns: ['id', 'title', 'form_type', 'status'] },
    member: { foreignKey: 'member_id', columns: ['id', 'first_name', 'last_name', 'email'] },
  },
  article_view: {
    blog_post: { foreignKey: 'article_id', columns: ['id', 'title', 'category', 'status'] },
    member: { foreignKey: 'member_id', columns: ['id', 'first_name', 'last_name'] },
  },
  support_ticket: {
    member: { foreignKey: 'member_id', columns: ['id', 'first_name', 'last_name', 'email'] },
  },
  program_ticket_transaction: {
    organization: { foreignKey: 'organization_id', columns: ['id', 'name', 'org_type'] },
  },
  job_posting: {
    organization: { foreignKey: 'organization_id', columns: ['id', 'name', 'org_type'] },
  },
  member_group_assignment: {
    member: { foreignKey: 'member_id', columns: ['id', 'first_name', 'last_name', 'email'] },
    member_group: { foreignKey: 'member_group_id', columns: ['id', 'name'] },
  },
};

const DATA_DICTIONARY = `
You have access to a PostgreSQL database via the Supabase client. Below are the key tables and their columns:

**member** - Individual people (members of organizations)
- id (uuid, PK), tenant_id (uuid, FK), organization_id (uuid, FK nullable), role_id (uuid, FK nullable)
- first_name (text), last_name (text), email (text), phone (text)
- status (text - active/inactive/pending), membership_type (text)
- created_date (timestamptz), last_login (timestamptz)
- job_title (text), department (text)

**organization** - Companies/entities within a tenant
- id (uuid, PK), tenant_id (uuid, FK)
- name (text), org_type (text), status (text)
- email (text), phone (text), website (text)
- address_line_1 (text), city (text), state (text), country (text), postcode (text)
- created_date (timestamptz)

**event** - Events managed by the tenant
- id (uuid, PK), tenant_id (uuid, FK)
- title (text), description (text), event_type (text)
- start_date (timestamptz), end_date (timestamptz)
- location (text), status (text - draft/published/cancelled/tbc)
  - status = 'tbc' means "To be confirmed": an interest-gathering event with no fixed date. TBC events are frequently cancelled/replaced and MUST be excluded by default from engagement/reporting queries (add status != 'tbc' or filter to status = 'published'). Only include TBC events if the user explicitly asks about them.
- max_attendees (integer), is_virtual (boolean)
- created_date (timestamptz)

**booking** - Event bookings by members
- id (uuid, PK), organization_id (uuid, FK), member_id (uuid, FK), event_id (uuid, FK)
- status (text - confirmed/cancelled/pending/waitlisted)
- booking_date (timestamptz), number_of_attendees (integer)
- created_date (timestamptz)

**role** - Member roles within a tenant
- id (uuid, PK), tenant_id (uuid, FK)
- name (text), description (text)
- excluded_features (jsonb array)

**form** - Forms created by the tenant
- id (uuid, PK), tenant_id (uuid, FK)
- title (text), description (text), status (text)
- form_type (text), created_date (timestamptz)

**form_submission** - Form responses
- id (uuid, PK), tenant_id (uuid, FK), form_id (uuid, FK), member_id (uuid, FK nullable)
- status (text), submitted_date (timestamptz), data (jsonb)
- created_date (timestamptz)

**resource** - Resources/documents shared with members
- id (uuid, PK), tenant_id (uuid, FK)
- title (text), description (text), resource_type (text - download/video/url)
- category_id (uuid, FK nullable), status (text)
- view_count (integer), created_date (timestamptz)

**job_posting** - Job listings
- id (uuid, PK), tenant_id (uuid, FK), organization_id (uuid, FK nullable)
- title (text), description (text), location (text)
- job_type (text), status (text), salary_range (text)
- created_date (timestamptz), closing_date (timestamptz)

**blog_post** - Articles/blog posts
- id (uuid, PK), tenant_id (uuid, FK)
- title (text), status (text - draft/published), category (text)
- author_id (uuid, FK nullable), view_count (integer)
- published_date (timestamptz), created_date (timestamptz)

**article_view** - Article view tracking
- id (uuid, PK), tenant_id (uuid, FK)
- article_id (uuid, FK), member_id (uuid, FK nullable)
- created_date (timestamptz)

**support_ticket** - Support tickets
- id (uuid, PK), tenant_id (uuid, FK), member_id (uuid, FK nullable)
- subject (text), status (text - open/in_progress/resolved/closed)
- priority (text), category (text)
- created_date (timestamptz), resolved_date (timestamptz)

**program_ticket_transaction** - Ticket purchase transactions
- id (uuid, PK), tenant_id (uuid, FK), organization_id (uuid, FK)
- program_name (text), transaction_type (text - purchase/refund/usage)
- quantity (integer), unit_price (numeric), total_cost_before_discount (numeric)
- original_quantity (integer), cancelled_quantity (integer)
- created_date (timestamptz)

**member_group** - Groups of members
- id (uuid, PK), tenant_id (uuid, FK)
- name (text), description (text)
- created_date (timestamptz)

**member_group_assignment** - Members assigned to groups
- id (uuid, PK), tenant_id (uuid, FK), member_group_id (uuid, FK), member_id (uuid, FK)
- created_date (timestamptz)
`;

const MUTATION_KEYWORDS = [
  'insert', 'update', 'delete', 'upsert', 'drop', 'alter', 'create',
  'truncate', 'grant', 'revoke', 'execute', 'call'
];

const ALLOWED_AGGREGATE_FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max'];

const MAX_ROWS = 500;

function parseSelectTokens(selectStr) {
  const tokens = [];
  let current = '';
  let depth = 0;
  for (const ch of selectStr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function validateRelationToken(token, table) {
  const relationMatch = token.match(/^(\w+)\s*(?:!inner|!left)?\s*\((.+)\)$/);
  if (!relationMatch) return `Invalid relation syntax: "${token}"`;

  const relatedTable = relationMatch[1];
  const innerSelect = relationMatch[2].trim();

  const tableJoins = ALLOWED_JOINS[table];
  if (!tableJoins || !tableJoins[relatedTable]) {
    return `Relation "${relatedTable}" is not allowed from table "${table}"`;
  }

  const allowedRelCols = tableJoins[relatedTable].columns;
  const innerTokens = innerSelect.split(',').map((s) => s.trim()).filter(Boolean);

  for (const innerToken of innerTokens) {
    if (innerToken.includes('(')) {
      return `Nested relation expansion is not allowed: "${innerToken}"`;
    }
    const bareCol = innerToken.split('::')[0].trim();
    if (bareCol === '*') {
      return `Wildcard (*) is not allowed in relation expansion for "${relatedTable}". Specify explicit columns.`;
    }
    if (!allowedRelCols.includes(bareCol)) {
      return `Column "${bareCol}" is not allowed for related table "${relatedTable}"`;
    }
  }

  return null;
}

function selectHasMixedRelationAndAggregate(selectStr) {
  if (!selectStr || selectStr === '*') return false;
  const tokens = parseSelectTokens(selectStr);
  const hasRelation = tokens.some((t) => {
    if (!t.includes('(') || !t.includes(')')) return false;
    return !t.match(/^(count|sum|avg|min|max)\s*\(/i);
  });
  const hasAggregate = tokens.some((t) => t.match(/^(count|sum|avg|min|max)\s*\(/i));
  return hasRelation && hasAggregate;
}

function validateSelectString(selectStr, table) {
  const errors = [];

  if (!selectStr || selectStr === '*') return errors;

  if (selectHasMixedRelationAndAggregate(selectStr)) {
    errors.push('Aggregate functions cannot be combined with relation expansion in the same select. Use visualization aggregation instead.');
    return errors;
  }

  const tokens = parseSelectTokens(selectStr);
  for (const token of tokens) {
    if (token.includes('(') && token.includes(')')) {
      const aggMatch = token.match(/^(count|sum|avg|min|max)\s*\((.*)?\)$/i);
      if (aggMatch) {
        const innerCol = (aggMatch[2] || '').trim();
        if (innerCol && innerCol !== '*' && innerCol !== '') {
          const bareCol = innerCol.split('::')[0].trim();
          if (!TABLE_COLUMNS[table]?.includes(bareCol)) {
            errors.push(`Column "${bareCol}" is not allowed for table "${table}"`);
          }
        }
        continue;
      }

      const relationError = validateRelationToken(token, table);
      if (relationError) {
        errors.push(relationError);
      }
      continue;
    }

    if (token.includes('!inner') || token.includes('!left')) {
      errors.push(`Unrecognized relation syntax "${token}"`);
      continue;
    }

    if (token.includes(':') && !token.includes('::')) {
      errors.push(`Rename syntax "${token}" is not allowed`);
      continue;
    }

    const colName = token.split('::')[0].trim();
    if (colName !== '*' && !TABLE_COLUMNS[table]?.includes(colName)) {
      errors.push(`Column "${colName}" is not allowed for table "${table}"`);
    }
  }

  return errors;
}

function sanitizeSelectForRelations(selectStr) {
  if (!selectStr || selectStr === '*') return { select: selectStr, strippedAggregateType: null };

  const tokens = parseSelectTokens(selectStr);

  const hasRelation = tokens.some((t) => {
    if (!t.includes('(') || !t.includes(')')) return false;
    return !t.match(/^(count|sum|avg|min|max)\s*\(/i);
  });

  if (!hasRelation) return { select: selectStr, strippedAggregateType: null };

  const aggregateTokens = tokens.filter((t) =>
    t.match(/^(count|sum|avg|min|max)\s*\(/i)
  );

  if (aggregateTokens.length === 0) return { select: selectStr, strippedAggregateType: null };

  const fullAggMatch = aggregateTokens[0].match(/^(count|sum|avg|min|max)\s*\(([^)]*)\)/i);
  const detectedAggType = fullAggMatch ? fullAggMatch[1].toLowerCase() : 'count';
  const innerColRaw = fullAggMatch ? (fullAggMatch[2] || '').trim() : '';
  const detectedAggColumn = (innerColRaw && innerColRaw !== '*') ? innerColRaw.split('::')[0].trim() : null;

  const cleaned = tokens.filter(
    (t) => !t.match(/^(count|sum|avg|min|max)\s*\(/i)
  );

  return {
    select: cleaned.join(', ') || '*',
    strippedAggregateType: detectedAggType,
    strippedAggregateColumn: detectedAggColumn,
  };
}

function validateQuery(queryDef) {
  const errors = [];

  if (!queryDef || !queryDef.table) {
    errors.push('No table specified in query');
    return errors;
  }

  if (!ALLOWED_TABLES.includes(queryDef.table)) {
    errors.push(`Table "${queryDef.table}" is not allowed`);
    return errors;
  }

  if (queryDef.joins) {
    for (const join of queryDef.joins) {
      const tableJoins = ALLOWED_JOINS[queryDef.table];
      if (!tableJoins || !tableJoins[join.table]) {
        errors.push(`Join with table "${join.table}" is not allowed from "${queryDef.table}"`);
      }
    }
  }

  if (queryDef.select && queryDef.select !== '*') {
    const selectErrors = validateSelectString(queryDef.select, queryDef.table);
    errors.push(...selectErrors);
  }

  if (queryDef.filters) {
    const allowedCols = TABLE_COLUMNS[queryDef.table] || [];
    for (const filter of queryDef.filters) {
      if (!allowedCols.includes(filter.column)) {
        errors.push(`Filter column "${filter.column}" is not allowed for table "${queryDef.table}"`);
      }
    }
  }

  if (queryDef.order) {
    const allowedCols = TABLE_COLUMNS[queryDef.table] || [];
    for (const ord of queryDef.order) {
      if (!allowedCols.includes(ord.column)) {
        errors.push(`Order column "${ord.column}" is not allowed for table "${queryDef.table}"`);
      }
    }
  }

  const queryStr = JSON.stringify(queryDef).toLowerCase();
  for (const keyword of MUTATION_KEYWORDS) {
    if (queryStr.includes(`"${keyword}"`) || queryStr.includes(`"method":"${keyword}"`)) {
      errors.push(`Mutation operation "${keyword}" is not allowed. Only read operations are permitted.`);
    }
  }

  return errors;
}

const TABLES_WITHOUT_TENANT_ID = ['booking'];

async function getTenantOrganizationIds(tenantId) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('organization')
    .select('id')
    .eq('tenant_id', tenantId);
  if (error || !data) return [];
  return data.map((o) => o.id);
}

async function executeSupabaseQuery(queryDef, tenantId) {
  if (!supabase) {
    throw new Error('Database not configured');
  }

  let query = supabase.from(queryDef.table);

  if (queryDef.select) {
    query = query.select(queryDef.select);
  } else {
    query = query.select('*');
  }

  if (TABLES_WITHOUT_TENANT_ID.includes(queryDef.table)) {
    const orgIds = await getTenantOrganizationIds(tenantId);
    if (orgIds.length === 0) {
      return [];
    }
    query = query.in('organization_id', orgIds);
  } else {
    query = query.eq('tenant_id', tenantId);
  }

  if (queryDef.filters) {
    for (const filter of queryDef.filters) {
      const { column, operator, value } = filter;
      switch (operator) {
        case 'eq': query = query.eq(column, value); break;
        case 'neq': query = query.neq(column, value); break;
        case 'gt': query = query.gt(column, value); break;
        case 'gte': query = query.gte(column, value); break;
        case 'lt': query = query.lt(column, value); break;
        case 'lte': query = query.lte(column, value); break;
        case 'like': query = query.like(column, value); break;
        case 'ilike': query = query.ilike(column, value); break;
        case 'in': query = query.in(column, value); break;
        case 'is': query = query.is(column, value); break;
        default: break;
      }
    }
  }

  if (queryDef.order) {
    for (const ord of queryDef.order) {
      query = query.order(ord.column, { ascending: ord.ascending !== false });
    }
  }

  const limit = Math.min(queryDef.limit || MAX_ROWS, MAX_ROWS);
  query = query.limit(limit);

  const { data, error } = await query;

  if (error) {
    throw new Error(`Query error: ${error.message}`);
  }

  return data || [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const context = await getTenantContext(req);

    if (!context.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const isAdmin = await hasAdminAccess(context);
    if (!isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!context.tenantId) {
      return res.status(400).json({ error: 'Tenant context not found' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const rateData = rateLimits.get(clientIp);
    if (rateData) {
      if (now < rateData.resetTime) {
        if (rateData.count >= RATE_LIMIT) {
          return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        rateData.count++;
      } else {
        rateLimits.set(clientIp, { count: 1, resetTime: now + RATE_WINDOW });
      }
    } else {
      rateLimits.set(clientIp, { count: 1, resetTime: now + RATE_WINDOW });
    }

    if (rateLimits.size > 1000) {
      for (const [ip, data] of rateLimits.entries()) {
        if (now > data.resetTime) rateLimits.delete(ip);
      }
    }

    const { prompt, conversationHistory } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt is required and must be a string' });
    }

    if (prompt.length > 2000) {
      return res.status(400).json({ error: 'Prompt exceeds maximum length of 2000 characters' });
    }

    const client = getOpenAIClient();
    if (!client) {
      return res.status(503).json({ error: 'AI service not configured. Please set up an OpenAI API key.' });
    }

    const systemPrompt = `You are a report generator for a membership/association management platform. You translate natural language requests into database queries and visualization configurations.

${DATA_DICTIONARY}

IMPORTANT RULES:
1. All queries MUST be read-only SELECT operations
2. All queries are automatically filtered by tenant_id - do NOT include tenant_id in your filters
3. Only use the tables and columns listed above - no other tables or columns exist
4. For the "booking" table, tenant scoping is done via organization_id, not tenant_id
5. Return a maximum of ${MAX_ROWS} rows
6. The "select" field supports: column names from the table, aggregate functions (count, sum, avg, min, max), and Supabase relation expansion for related tables. Relation expansion uses the syntax "related_table(col1, col2)" to embed data from foreign-key-linked tables. Available relations:
   - booking -> event(id, title, event_type, start_date, end_date, location, status), member(id, first_name, last_name, email, status), organization(id, name, org_type, status)
   - member -> organization(id, name, org_type, status), role(id, name, description)
   - form_submission -> form(id, title, form_type, status), member(id, first_name, last_name, email)
   - article_view -> blog_post(id, title, category, status), member(id, first_name, last_name)
   - support_ticket -> member(id, first_name, last_name, email)
   - program_ticket_transaction -> organization(id, name, org_type)
   - job_posting -> organization(id, name, org_type)
   - member_group_assignment -> member(id, first_name, last_name, email), member_group(id, name)
   Do NOT use rename syntax (e.g. "col:alias"). Do NOT nest relation expansions.
   CRITICAL: Do NOT combine aggregate functions (count(*), sum(), avg(), etc.) with relation expansion (e.g. form(id,title)) in the same "select" string. PostgREST cannot parse them together and the query will fail. When you need related table data AND aggregation, use relation expansion in "select" to fetch raw data, then set "aggregation" and "aggregationColumn" in the visualization config so the frontend performs the aggregation.
7. When counting or aggregating with relation expansion, return raw data using relation expansion in select and set "aggregation" (count/sum/avg) and "aggregationColumn" in the visualization config. The frontend will perform the aggregation. Only use aggregate functions like count(*) in the select string when there is NO relation expansion in the same select
8. Choose the most appropriate chart type for the data:
   - bar: comparing categories
   - line: trends over time
   - pie: proportions/distribution (use for small number of categories, <=8)
   - area: cumulative trends over time
9. Provide meaningful axis labels and a clear report title
10. Include summary statistics where appropriate (totals, averages, counts)
11. For any query involving the "event" table (or relation-expanded event data), exclude "To be confirmed" events by default: add a filter { "column": "status", "operator": "neq", "value": "tbc" } (or filter to status = 'published'). TBC events are interest-gatherers that are frequently cancelled/replaced and must not inflate engagement/reporting figures. Only include them when the user explicitly asks about TBC events.

You MUST respond with valid JSON in this exact format:
{
  "title": "Report title",
  "description": "Brief description of what this report shows",
  "query": {
    "table": "table_name",
    "select": "column1, column2",
    "filters": [
      { "column": "column_name", "operator": "eq|neq|gt|gte|lt|lte|like|ilike|in|is", "value": "value" }
    ],
    "order": [
      { "column": "column_name", "ascending": true }
    ],
    "limit": 100
  },
  "visualization": {
    "chartType": "bar|line|pie|area",
    "xAxis": { "key": "column_name", "label": "X Axis Label" },
    "yAxis": { "key": "column_name_or_computed", "label": "Y Axis Label" },
    "groupBy": "optional_column_for_grouping",
    "aggregation": "count|sum|avg|none",
    "aggregationColumn": "column_to_aggregate"
  },
  "summaryStats": [
    { "label": "Stat Label", "type": "count|sum|avg|max|min|distinct", "column": "column_name", "filter": null }
  ],
  "columns": [
    { "key": "column_name", "label": "Display Label", "format": "text|number|date|currency" }
  ]
}

If the user's request is unclear or cannot be answered with the available data, respond with:
{
  "error": "A helpful message explaining what's unclear and suggesting alternatives"
}`;

    const messages = [{ role: 'system', content: systemPrompt }];

    if (conversationHistory && Array.isArray(conversationHistory)) {
      for (const msg of conversationHistory.slice(-6)) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }

    messages.push({ role: 'user', content: prompt });

    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      max_completion_tokens: 2048,
      response_format: { type: 'json_object' },
      temperature: 0.1,
    });

    const responseContent = completion.choices[0]?.message?.content || '';
    let aiResponse;
    try {
      aiResponse = JSON.parse(responseContent);
    } catch {
      return res.status(500).json({ error: 'Failed to parse AI response. Please try rephrasing your request.' });
    }

    if (aiResponse.error) {
      return res.json({ error: aiResponse.error, isAIError: true });
    }

    if (!aiResponse.query || !aiResponse.query.table) {
      return res.status(500).json({ error: 'AI did not generate a valid query. Please try rephrasing your request.' });
    }

    if (aiResponse.query.select) {
      const { select: sanitizedSelect, strippedAggregateType, strippedAggregateColumn } = sanitizeSelectForRelations(aiResponse.query.select);
      aiResponse.query.select = sanitizedSelect;

      if (strippedAggregateType) {
        const viz = aiResponse.visualization;
        const supportedFrontendAggregations = ['count', 'sum', 'avg'];
        const safeAggType = supportedFrontendAggregations.includes(strippedAggregateType)
          ? strippedAggregateType
          : 'count';
        if (viz && (!viz.aggregation || viz.aggregation === 'none')) {
          if (!supportedFrontendAggregations.includes(strippedAggregateType)) {
            console.warn(`[AI Reports] Unsupported aggregate "${strippedAggregateType}" stripped from select; falling back to "count" for frontend aggregation`);
          }
          viz.aggregation = safeAggType;
        }
        if (viz && strippedAggregateColumn && !viz.aggregationColumn) {
          viz.aggregationColumn = strippedAggregateColumn;
        }
        if (viz && viz.yAxis && !viz.yAxis.key) {
          viz.yAxis.key = 'value';
        }
      }
    }

    const validationErrors = validateQuery(aiResponse.query);
    if (validationErrors.length > 0) {
      console.error('[AI Reports] Query validation failed:', validationErrors);
      return res.status(400).json({
        error: 'The generated query failed safety validation. Please try a different request.',
        details: validationErrors,
      });
    }

    const data = await executeSupabaseQuery(aiResponse.query, context.tenantId);

    return res.json({
      title: aiResponse.title,
      description: aiResponse.description,
      data,
      visualization: aiResponse.visualization,
      summaryStats: aiResponse.summaryStats || [],
      columns: aiResponse.columns || [],
      rowCount: data.length,
      query: {
        table: aiResponse.query.table,
        filters: aiResponse.query.filters || [],
      },
    });
  } catch (error) {
    console.error('[AI Reports] Error:', error);

    if (error.status === 429 || error.code === 'rate_limit_exceeded') {
      return res.status(429).json({ error: 'AI service rate limit reached. Please try again in a few seconds.' });
    }

    return res.status(500).json({ error: error.message || 'An unexpected error occurred' });
  }
}
