// Adapt the existing PostgREST filter builders to a small, validated predicate
// tree. No SQL, table names, or expressions are accepted from the browser.
const split = (text) => {
  const parts = [];
  let start = 0, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && quoted) { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
  }
  if (quoted || depth !== 0) throw new Error('Invalid list filter');
  parts.push(text.slice(start));
  return parts;
};
const unquote = (value) => value.startsWith('"') && value.endsWith('"')
  ? value.slice(1, -1).replace(/\\(.)/g, '$1') : value;
function predicate(column, operator, value) {
  const negate = operator.startsWith('not.');
  const op = negate ? operator.slice(4) : operator;
  if (!['eq', 'neq', 'in', 'is', 'like', 'ilike'].includes(op)) throw new Error('Unsupported list predicate');
  if (op === 'in' && !Array.isArray(value)) {
    if (!String(value).startsWith('(') || !String(value).endsWith(')')) throw new Error('Invalid list predicate');
    value = split(value.slice(1, -1)).map(unquote);
  }
  if ((op === 'like' || op === 'ilike') && typeof value === 'string') value = value.replace(/\*/g, '%');
  return { column, op, value, negate };
}
export function createAlphabetFilterRecorder(joins = {}) {
  const base = [];
  const add = (column, op, value) => {
    const path = column.split('.');
    const field = path.pop();
    const owner = path.join('.');
    if (owner) {
      if (!joins[owner]) throw new Error('Unknown filter join');
      joins[owner].filters.push(predicate(field, op, value));
    } else if (joins[field] && op === 'is' && value === null) {
      joins[field].negative = true;
    } else base.push(predicate(field, op, value));
    return q;
  };
  const q = {
    eq: (c, v) => add(c, 'eq', v),
    neq: (c, v) => add(c, 'neq', v),
    in: (c, v) => add(c, 'in', v),
    is: (c, v) => {
      if (joins[c]) { joins[c].negative = true; return q; }
      return add(c, 'is', v);
    },
    not: (c, op, v) => add(c, `not.${op}`, v),
    ilike: (c, v) => add(c, 'ilike', v),
    or: (text, options = {}) => {
      const nodes = split(text).map(part => {
        const match = part.match(/^([a-z_]+)\.(not\.)?(eq|neq|is|in|like|ilike)\.(.*)$/s);
        if (!match) throw new Error('Invalid list OR filter');
        return predicate(match[1], (match[2] || '') + match[3], match[3] === 'in' ? match[4] : unquote(match[4]));
      });
      const destination = options.foreignTable ? joins[options.foreignTable]?.filters : base;
      if (!destination) throw new Error('Unknown filter join');
      destination.push({ or: nodes });
      return q;
    },
    result: () => ({ base, joins }),
  };
  return q;
}
