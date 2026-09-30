import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../.replit', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const suites = JSON.parse(readFileSync(new URL('./regression-suites.json', import.meta.url), 'utf8'));
const workflows = config.split('[[workflows.workflow]]').slice(1);
const nameOf = block => block.match(/^name = "([^"]+)"$/m)?.[1];

test('Run and default Project start only the application', () => {
  assert.match(config, /runButton = "Project"/);
  const project = workflows.find(block => nameOf(block) === 'Project');
  assert.deepEqual([...project.matchAll(/^args = "([^"]+)"$/gm)].map(match => match[1]), ['Start application']);
  const app = workflows.find(block => nameOf(block) === 'Start application');
  assert.match(app, /args = "npm run dev"/);
  assert.equal(packageJson.scripts.dev, 'NODE_ENV=development tsx server/index-dev.ts');
});

test('ordinary validation workflows use the isolated entry point and never live scripts', () => {
  for (const block of workflows) {
    if (!block.includes('isValidation = true')) continue;
    assert.match(block, /args = "(?:node scripts\/run-regression-suite\.mjs|npm run test:safety-boundaries)/);
    assert.doesNotMatch(block, /verify:production|verify-custom-object-relationship-list-live/);
  }
  for (const [name, command] of Object.entries(suites)) {
    assert.doesNotMatch(name, /live|production/);
    assert.doesNotMatch(command, /verify-|DEST_|SOURCE_|--apply/);
  }
});

test('production verification is separately available without an implicit opt-in', () => {
  assert.equal(packageJson.scripts['verify:production:relationships'],
    'node scripts/verify-custom-object-relationship-list-live.mjs');
  assert.equal(workflows.some(block => /name = "custom-object-crm-live"/.test(block)), false);
});