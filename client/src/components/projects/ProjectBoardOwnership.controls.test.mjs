import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import { build } from 'esbuild';

// Execute the real settings component and hooks; replace visual primitives
// only so the permission controls can be inspected without a signed-in browser.
const page = readFileSync(new URL('../../pages/ProjectBoard.jsx', import.meta.url), 'utf8');
const component = page.slice(page.indexOf('export function BoardSettingsModal('));
const tags = [...new Set([...component.matchAll(/<([A-Z]\w*)\b/g)].map(match => match[1]))];
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(), loader: 'jsx',
    contents: `import React,{useState,useEffect} from 'react';
      import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
      const toast={success(){},error(){}};
      const apiRequest=()=>{throw Error('A static control render must never write data');};
      const primitive=(name,props)=>React.createElement(name==='Select'?'section':'div',
        name==='Select'?{'data-role':props.value,'data-disabled':String(!!props.disabled)}:{},props.children);
      ${tags.map(name => `const ${name}=props=>primitive('${name}',props);`).join('\n')}
      ${component}`,
  },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', logLevel: 'silent',
});
const compiled = new Module(`${process.cwd()}/board-ownership-controls.cjs`);
compiled.filename = `${process.cwd()}/board-ownership-controls.cjs`;
compiled.paths = Module._nodeModulePaths(process.cwd());
compiled._compile(bundle.outputFiles[0].text, compiled.filename);
const React = compiled.require('react');
const { renderToStaticMarkup } = compiled.require('react-dom/server');
const { QueryClient, QueryClientProvider } = compiled.require('@tanstack/react-query');

function render(roles, userRole = 'owner') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(compiled.exports.BoardSettingsModal, {
      boardId: 'fixture', boardName: 'Fixture', open: true, onOpenChange() {}, onMembersChange() {}, userRole,
      members: roles.map((role, index) => ({ identity_id: `person-${index}`, role, first_name: 'Fixture' })),
    })));
  client.clear();
  return { html, owners: [...html.matchAll(/data-role="owner" data-disabled="(true|false)"/g)].map(match => match[1]) };
}

test('the only owner cannot be demoted, and the handoff instruction is visible', () => {
  const { html, owners } = render(['owner', 'member']);
  assert.deepEqual(owners, ['true']);
  assert.match(html, /Assign another owner before changing or removing the last board owner/);
  assert.match(html, /data-role="member" data-disabled="false"/, 'another member remains available for promotion');
});

test('an owner can change ownership once another owner exists', () => {
  const { html, owners } = render(['owner', 'owner']);
  assert.deepEqual(owners, ['false', 'false']);
  assert.doesNotMatch(html, /Assign another owner before changing/);
});

test('administrators cannot edit owners, including when several owners exist', () => {
  assert.deepEqual(render(['owner', 'owner', 'member'], 'admin').owners, ['true', 'true']);
});

test('legacy ownerless boards are not silently promoted by rendering settings', () => {
  const { html, owners } = render(['admin'], 'admin');
  assert.deepEqual(owners, []);
  assert.doesNotMatch(html, /Assign another owner before changing/);
});
