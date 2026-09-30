#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import pg from 'pg';
const { Client } = pg;

const DEST_URL = process.argv.find(a => a.startsWith('--dest='))?.split('=').slice(1).join('=');
const TENANT_ID = process.argv.find(a => a.startsWith('--tenant-id='))?.split('=')[1] || 'fd82da65-aab7-4a5c-85b8-b2febeb2003d';

if (!DEST_URL) {
  console.error('Usage: node scripts/migrations/check-jsonb.mjs --dest=URL [--tenant-id=ID]');
  process.exit(1);
}

async function run() {
  const client = new Client({ connectionString: DEST_URL, ssl: true });
  await client.connect();

  console.log('\n=== Checking JSONB array fields for tenant ===');
  console.log(`Tenant ID: ${TENANT_ID}\n`);

  // Check navigation_item for issues
  console.log('--- navigation_item.children ---');
  const navItems = await client.query(`
    SELECT id, title, children, jsonb_typeof(children) as children_type
    FROM navigation_item 
    WHERE tenant_id = $1 AND children IS NOT NULL
  `, [TENANT_ID]);
  let navIssues = 0;
  for (const row of navItems.rows) {
    if (row.children_type !== 'array') {
      console.log(`BAD: id=${row.id} title="${row.title}" children is ${row.children_type}: ${JSON.stringify(row.children)}`);
      navIssues++;
    }
  }
  console.log(`Checked ${navItems.rowCount} items with children, found ${navIssues} issues`);

  // Check portal_page elements field (should be array of elements)
  console.log('\n--- portal_page.elements ---');
  const pages = await client.query(`
    SELECT id, title, elements, jsonb_typeof(elements) as elements_type
    FROM portal_page 
    WHERE tenant_id = $1 AND elements IS NOT NULL
  `, [TENANT_ID]);
  let pageIssues = 0;
  for (const row of pages.rows) {
    if (row.elements_type !== 'array') {
      console.log(`BAD: id=${row.id} title="${row.title}" elements is ${row.elements_type}`);
      pageIssues++;
    }
  }
  console.log(`Checked ${pages.rowCount} pages with elements, found ${pageIssues} issues`);

  // Check role permissions (should be array)
  console.log('\n--- role.permissions ---');
  const roles = await client.query(`
    SELECT id, name, permissions, jsonb_typeof(permissions) as perm_type
    FROM role 
    WHERE tenant_id = $1 AND permissions IS NOT NULL
  `, [TENANT_ID]);
  let roleIssues = 0;
  for (const row of roles.rows) {
    if (row.perm_type !== 'array') {
      console.log(`BAD: id=${row.id} name="${row.name}" permissions is ${row.perm_type}`);
      roleIssues++;
    }
  }
  console.log(`Checked ${roles.rowCount} roles with permissions, found ${roleIssues} issues`);

  // Check typography_style (could have arrays)
  console.log('\n--- typography_style ---');
  const styles = await client.query(`
    SELECT id, name 
    FROM typography_style 
    WHERE tenant_id = $1
    LIMIT 10
  `, [TENANT_ID]);
  console.log(`Found ${styles.rowCount} typography styles`);

  await client.end();
  
  const totalIssues = navIssues + pageIssues + roleIssues;
  console.log(`\n=== Total issues found: ${totalIssues} ===`);
}

run().catch(e => { console.error(e); process.exit(1); });
