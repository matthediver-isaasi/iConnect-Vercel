import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchRoutes } from 'react-router-dom';
import { buildComponentPageNames, resolveRoutePageName } from './routePageClassification.js';

// Stand-ins for the route components registered in pages/index.jsx.
const FormSubmissionView = () => null;
const FormSubmissions = () => null;
const FormView = () => null;
const ProfileAffiliationFormRoute = () => null;
const DynamicPage = () => null;
const DynamicDirectoryView = () => null;
const CatchAllNotFound = () => null;
const ProjectBoard = () => null;
const DomainSettings = () => null;

const PAGES = { FormSubmissions, FormSubmissionView, FormView, DynamicDirectoryView, DomainSettings };
const routes = [
  { path: '/FormSubmissions', component: FormSubmissions },
  { path: '/FormSubmission/:submissionId', component: FormSubmissionView },
  { path: '/forms/:slug', component: ProfileAffiliationFormRoute },
  { path: '/directory/:slug', component: DynamicDirectoryView },
  { path: '/ProjectBoard/:id', component: ProjectBoard },
  { path: '/domain-settings', component: DomainSettings },
  { path: '/:slug', component: DynamicPage },
  { path: '/:micrositePrefix/:slug', component: DynamicPage },
  { path: '/*', component: CatchAllNotFound },
];

// Mirrors the URL classifier's relevant behaviour: explicit prefix rules,
// then a PAGES lookup on the last segment, else "_DynamicPage".
function pathPageName(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && ['forms', 'survey'].includes(parts[0].toLowerCase())) return 'FormView';
  const last = parts.at(-1) || '';
  return Object.keys(PAGES).find((name) => name.toLowerCase() === last.toLowerCase()) || '_DynamicPage';
}

function classify(pathname) {
  const match = matchRoutes(routes, pathname).at(-1);
  return resolveRoutePageName({
    pathPageName: match.route.component === DynamicPage ? '_DynamicPage' : pathPageName(pathname),
    component: match.route.component,
    routePath: match.route.path,
    componentPageNames: buildComponentPageNames(PAGES, [[ProjectBoard, 'ProjectBoard']]),
    dynamicComponents: new Set([DynamicPage]),
    retainDynamicComponents: new Set([CatchAllNotFound, DynamicDirectoryView]),
  });
}

test('protected ID routes classify as their real page, not a CMS page', () => {
  assert.equal(classify('/FormSubmission/2f0e8c1a-7d3b-4c9e-9a51-6b2d8e4f1c30'), 'FormSubmissionView');
  assert.equal(classify('/ProjectBoard/42'), 'ProjectBoard');
});

test('CMS slugs and microsite pages remain dynamic', () => {
  assert.equal(classify('/homely'), '_DynamicPage');
  assert.equal(classify('/careers/homely'), '_DynamicPage');
});

test('hybrid parameterised routes keep their existing classification', () => {
  assert.equal(classify('/forms/annual-return'), 'FormView');
  assert.equal(classify('/directory/partners'), '_DynamicPage');
  assert.equal(classify('/a/b/c/d'), '_DynamicPage');
});

test('static routes are not reclassified by component', () => {
  assert.equal(classify('/domain-settings'), '_DynamicPage');
  assert.equal(classify('/FormSubmissions'), 'FormSubmissions');
});

test('the router wires the classification for submission deep links', () => {
  const source = readFileSync(new URL('../pages/index.jsx', import.meta.url), 'utf8');
  assert.match(source, /<Route path="\/FormSubmission\/:submissionId" element={<FormSubmissionView \/>} \/>/);
  assert.match(source, /^\s+FormSubmissionView: FormSubmissionView,/m);
  assert.match(source, /resolveRoutePageName\(\{/);
  assert.match(source, /routePath: matches\?\.at\(-1\)\?\.route\.path/);
  const layout = readFileSync(new URL('../pages/Layout.jsx', import.meta.url), 'utf8');
  assert.match(layout, /const returnTo = `\$\{location\.pathname\}\$\{location\.search\}\$\{location\.hash\}`;/);
});
