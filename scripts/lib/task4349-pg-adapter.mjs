// Minimal Supabase-fluent adapter for Task #4349's shared validator/replay.
// Deliberately unsupported methods fail instead of silently changing semantics.

const identifier = value => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Unsupported SQL identifier: ${value}`);
  return `"${value}"`;
};

function selectedColumns(value = '*') {
  if (value.trim() === '*') return '*';
  return value.split(',').map(column => identifier(column.trim())).join(', ');
}

class PgFluentQuery {
  constructor(client, table) {
    this.client = client;
    this.table = identifier(table);
    this.filters = [];
    this.operation = 'select';
    this.selected = '*';
    this.payload = null;
  }

  select(columns = '*') { this.selected = selectedColumns(columns); return this; }
  eq(column, value) { this.filters.push({ kind: 'eq', column: identifier(column), value }); return this; }
  is(column, value) {
    if (value !== null) throw new Error('Task #4349 pg adapter supports only IS NULL');
    this.filters.push({ kind: 'null', column: identifier(column) });
    return this;
  }
  in(column, values) {
    if (!Array.isArray(values) || values.length === 0) throw new Error('Task #4349 pg adapter requires a non-empty IN list');
    this.filters.push({ kind: 'in', column: identifier(column), value: values });
    return this;
  }
  insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
  update(payload) { this.operation = 'update'; this.payload = payload; return this; }

  where(values) {
    if (!this.filters.length) return '';
    const clauses = this.filters.map(filter => {
      if (filter.kind === 'null') return `${filter.column} IS NULL`;
      values.push(filter.value);
      if (filter.kind === 'in') return `${filter.column} = ANY($${values.length})`;
      if (filter.column === '"processing_notes"') return `${filter.column} = $${values.length}::jsonb`;
      return `${filter.column} = $${values.length}`;
    });
    return ` WHERE ${clauses.join(' AND ')}`;
  }

  async execute() {
    try {
      const values = [];
      let sql;
      if (this.operation === 'select') {
        sql = `SELECT ${this.selected} FROM ${this.table}${this.where(values)}`;
      } else if (this.operation === 'insert') {
        if (Array.isArray(this.payload)) throw new Error('Task #4349 pg adapter does not support bulk inserts');
        const columns = Object.keys(this.payload || {});
        if (!columns.length) throw new Error('Task #4349 pg adapter requires insert values');
        for (const column of columns) values.push(this.payload[column]);
        sql = `INSERT INTO ${this.table} (${columns.map(identifier).join(', ')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING ${this.selected}`;
      } else if (this.operation === 'update') {
        const columns = Object.keys(this.payload || {});
        if (!columns.length) throw new Error('Task #4349 pg adapter requires update values');
        const assignments = columns.map(column => {
          const value = this.payload[column];
          values.push(column === 'processing_notes' ? JSON.stringify(value) : value);
          return `${identifier(column)} = $${values.length}${column === 'processing_notes' ? '::jsonb' : ''}`;
        });
        sql = `UPDATE ${this.table} SET ${assignments.join(', ')}${this.where(values)} RETURNING ${this.selected}`;
      } else {
        throw new Error(`Unsupported Task #4349 operation: ${this.operation}`);
      }
      const result = await this.client.query(sql, values);
      return { data: result.rows, error: null };
    } catch (error) {
      return {
        data: null,
        error: {
          message: error.message,
          code: error.code,
          constraint: error.constraint,
          details: error.detail,
          hint: error.hint,
        },
      };
    }
  }

  async maybeSingle() {
    const result = await this.execute();
    if (result.error) return result;
    if (result.data.length > 1) {
      return { data: null, error: { message: 'Expected at most one row' } };
    }
    return { data: result.data[0] || null, error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

export function createTask4349PgAdapter(client) {
  if (!client?.query) throw new Error('A checked-out pg transaction client is required');
  return {
    transactionCapable: true,
    from(table) {
      return new PgFluentQuery(client, table);
    },
  };
}