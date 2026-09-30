const EXPECTED_PROJECT_REF = 'lvmzliemqnieeoruhkik';
const EXPECTED_SUPABASE_ORIGIN = `https://${EXPECTED_PROJECT_REF}.supabase.co`;
const OPT_IN_VALUE = 'custom-object-relationship-list';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const productionVerificationContract = Object.freeze({
  expectedProjectRef: EXPECTED_PROJECT_REF,
  expectedSupabaseOrigin: EXPECTED_SUPABASE_ORIGIN,
  optInEnvironmentVariable: 'ICONNECT_PRODUCTION_READ_ONLY_VERIFY',
  optInValue: OPT_IN_VALUE,
  tenantEnvironmentVariable: 'ICONNECT_PRODUCTION_VERIFY_TENANT_ID',
});

function parsedUrl(value, name) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

export function assertProductionVerificationOptIn(env) {
  if (env.ICONNECT_PRODUCTION_READ_ONLY_VERIFY !== OPT_IN_VALUE) {
    throw new Error(
      `Refusing production verification: set ICONNECT_PRODUCTION_READ_ONLY_VERIFY=${OPT_IN_VALUE} explicitly`,
    );
  }

  const tenantId = String(env.ICONNECT_PRODUCTION_VERIFY_TENANT_ID || '').trim();
  if (!UUID.test(tenantId)) {
    throw new Error(
      'Refusing production verification: ICONNECT_PRODUCTION_VERIFY_TENANT_ID must be an explicit tenant UUID',
    );
  }

  const supabaseUrl = parsedUrl(env.DEST_SUPABASE_URL, 'DEST_SUPABASE_URL');
  if (
    supabaseUrl.origin !== EXPECTED_SUPABASE_ORIGIN
    || supabaseUrl.pathname !== '/'
    || supabaseUrl.username
    || supabaseUrl.password
    || supabaseUrl.search
    || supabaseUrl.hash
  ) {
    throw new Error(
      `Refusing production verification: DEST_SUPABASE_URL must be exactly ${EXPECTED_SUPABASE_ORIGIN}`,
    );
  }

  const databaseUrl = parsedUrl(env.DEST_DATABASE_URL, 'DEST_DATABASE_URL');
  const decodedUser = decodeURIComponent(databaseUrl.username || '');
  const supportedProtocol = ['postgres:', 'postgresql:'].includes(databaseUrl.protocol);
  const supportedPort = (databaseUrl.port || '5432') === '5432';
  const directProjectHost = (
    databaseUrl.hostname === `db.${EXPECTED_PROJECT_REF}.supabase.co`
    && decodedUser === 'postgres'
  );
  const poolerProjectHost = (
    databaseUrl.hostname.endsWith('.pooler.supabase.com')
    && decodedUser === `postgres.${EXPECTED_PROJECT_REF}`
  );
  if (
    !supportedProtocol
    || !supportedPort
    || databaseUrl.pathname !== '/postgres'
    || !databaseUrl.password
    || databaseUrl.search
    || databaseUrl.hash
    || (!directProjectHost && !poolerProjectHost)
  ) {
    throw new Error(
      `Refusing production verification: DEST_DATABASE_URL must identify Supabase project ${EXPECTED_PROJECT_REF}`,
    );
  }

  return {
    connectionString: env.DEST_DATABASE_URL,
    tenantId,
  };
}

export function productionPgClientOptions(connectionString) {
  return {
    connectionString,
    // Production verification must validate the Supabase TLS certificate.
    // Never copy the migration runners' rejectUnauthorized:false setting here.
    ssl: { rejectUnauthorized: true },
  };
}

const READ_ONLY_SQL = /^(?:SELECT|WITH|SHOW)\b/i;
const TRANSACTION_SQL = /^(?:BEGIN(?:\s+TRANSACTION)?\s+READ\s+ONLY|SET\s+TRANSACTION\s+READ\s+ONLY|ROLLBACK)\s*;?$/i;
const WRITE_CAPABLE_SQL = /\b(?:ALTER|CALL|COPY|CREATE|DELETE|DO|DROP|GRANT|INSERT|LOCK|MERGE|REFRESH|REINDEX|REVOKE|TRUNCATE|UPDATE|VACUUM)\b/i;
const SELECT_INTO = /\bSELECT\b[\s\S]*\bINTO\b/i;
const REVIEWED_OPERATIONS = new Map([
  ['transaction:begin-read-only', /^BEGIN READ ONLY$/i],
  ['transaction:confirm-read-only', /^SELECT current_setting\('transaction_read_only'\) AS transaction_read_only$/i],
  ['tenant-scope-validation', /^SELECT id FROM public\.tenant WHERE id = \$1::uuid$/i],
  ['function-security-metadata', /^SELECT p\.proname,[\s\S]+FROM pg_proc p[\s\S]+ORDER BY p\.proname$/i],
  ['tenant-scoped-candidate-read', /^WITH candidates AS \([\s\S]+\) SELECT c\.\* FROM candidates c[\s\S]+LIMIT 1$/i],
  [
    'rpc:custom_object_record_relationship_list:filtered',
    /^SELECT \* FROM public\.custom_object_record_relationship_list\(\s*\$1::uuid, \$2::uuid, false, \$3::jsonb, \$4::jsonb, NULL, 0, 100\s*\)$/i,
  ],
  [
    'rpc:custom_object_record_relationship_projection',
    /^SELECT \* FROM public\.custom_object_record_relationship_projection\(\s*\$1::uuid, \$2::uuid, \$3::jsonb, \$4::uuid\[\], 3\s*\)$/i,
  ],
  [
    'rpc:custom_object_record_relationship_list:sorted',
    /^SELECT \* FROM public\.custom_object_record_relationship_list\(\s*\$1::uuid, \$2::uuid, false, \$3::jsonb, '\[\]'::jsonb, \$4::jsonb, 0, 5\s*\)$/i,
  ],
  [
    'rpc:custom_object_record_relationship_list:out-of-range',
    /^SELECT \* FROM public\.custom_object_record_relationship_list\(\s*\$1::uuid, \$2::uuid, false, \$3::jsonb, '\[\]'::jsonb, \$4::jsonb, \$5, 5\s*\)$/i,
  ],
  ['transaction:rollback', /^ROLLBACK$/i],
  // Test-only reviewed reads exercise the adapter without broadening production
  // script labels to arbitrary SELECT statements.
  ['test:tenant-read', /^SELECT id FROM tenant WHERE id = \$1$/i],
]);

export function createAuditedReadOnlyQuery(client, audit = []) {
  return async function query(text, values = [], auditLabel) {
    const normalized = String(text || '').trim().replace(/\s+/g, ' ');
    const withoutTrailingSemicolon = normalized.replace(/;$/, '');
    const reviewedPattern = REVIEWED_OPERATIONS.get(auditLabel);
    if (
      (!READ_ONLY_SQL.test(withoutTrailingSemicolon) && !TRANSACTION_SQL.test(withoutTrailingSemicolon))
      || WRITE_CAPABLE_SQL.test(withoutTrailingSemicolon)
      || SELECT_INTO.test(withoutTrailingSemicolon)
      || withoutTrailingSemicolon.includes(';')
      || !reviewedPattern
      || !reviewedPattern.test(withoutTrailingSemicolon)
    ) {
      throw new Error(`Production verification blocked non-read-only SQL: ${normalized.slice(0, 80)}`);
    }
    audit.push({
      label: auditLabel,
      operation: normalized.match(/^([A-Z]+)/i)?.[1]?.toUpperCase() || 'UNKNOWN',
      parameterCount: Array.isArray(values) ? values.length : 0,
    });
    return client.query(text, values);
  };
}
