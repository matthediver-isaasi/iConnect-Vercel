import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./CustomObjectRecords.jsx', import.meta.url), 'utf8');
const workspaceStart = source.indexOf('function CustomObjectRecordListWorkspace');
const workspaceEnd = source.indexOf('function LegacyCustomObjectRecordList');
const workspace = source.slice(workspaceStart, workspaceEnd);

test('Custom Object list renders the core CRM workspace regions and visual states', () => {
  assert.ok(workspaceStart >= 0 && workspaceEnd > workspaceStart);
  assert.match(workspace, /<header className=/);
  assert.match(workspace, /<aside className=/);
  assert.match(workspace, /<SavedViewSwitcher/);
  assert.match(workspace, /Search filters\.\.\./);
  assert.match(workspace, /<FilterOperatorMenu/);
  assert.match(workspace, /Hidden filters/);
  assert.match(workspace, /Configure columns/);
  assert.match(workspace, /<SortableHeader/);
  assert.match(workspace, /Records could not be loaded/);
  assert.match(workspace, /No records found/);
  assert.match(workspace, /Page \{state\.page\} of \{pages\}/);
});

test('Custom Object list uses the full-width, full-height CRM shell', () => {
  const listRender = workspace.slice(workspace.indexOf('const canCreate'));
  assert.match(listRender, /<main className="min-h-screen bg-slate-50">/);
  assert.match(listRender, /<div className="flex h-screen min-w-0 overflow-hidden">/);
  assert.match(listRender, /<section className="flex min-w-0 flex-1 flex-col overflow-hidden">/);
  assert.match(listRender, /<div className="min-h-0 flex-1 overflow-auto">/);
  assert.doesNotMatch(listRender, /<Workspace/);
  assert.doesNotMatch(listRender, /max-w-7xl/);
  assert.doesNotMatch(listRender, /mx-auto/);
});

test('constrained Custom Object screens retain their centered workspace', () => {
  const constrainedWorkspace = source.slice(
    source.indexOf('function Workspace'),
    source.indexOf('const filterOperators'),
  );
  const recordForm = source.slice(
    source.indexOf('export function CustomObjectRecordForm'),
    source.indexOf('export function CustomObjectRecordDetail'),
  );
  assert.match(constrainedWorkspace, /mx-auto max-w-7xl/);
  assert.match(recordForm, /<Workspace object=\{object\} backToRecords>/);
  assert.match(recordForm, /mx-auto max-w-3xl/);
});

test('Custom Object list keeps relationship controls and bounded cells inside the CRM workspace', () => {
  assert.match(source, /relationship-filter-options/);
  assert.match(workspace, /column\.kind === "relationship"/);
  assert.match(workspace, /boundedLabels\(relationshipValuesFor\(record, column\), 3\)/);
  assert.match(workspace, /<Badge variant="outline">Relationship<\/Badge>/);
});

test('object route changes remount isolated list state', () => {
  assert.match(source, /<CustomObjectRecordListWorkspace key=\{objectId\} objectId=\{objectId\} \/>/);
});

test('saved relationship views wait for server-authorized relationship metadata', () => {
  assert.match(workspace, /const listMetadataResolved = Boolean\(recordsQuery\.data\?\.metadata\)/);
  assert.match(
    workspace,
    /if \(!listMetadataResolved\) \{[\s\S]*?restoredViewRef\.current = true;[\s\S]*?pendingViewRef\.current = view;[\s\S]*?return;/,
  );
  assert.match(workspace, /if \(!viewsLoaded \|\| !listMetadataResolved \|\| restoredViewRef\.current/);
  assert.match(workspace, /relationshipColumns: requestedRelationshipColumns/);
});