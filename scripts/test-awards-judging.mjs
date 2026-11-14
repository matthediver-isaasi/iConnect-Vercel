import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const files=directory=>readdirSync(directory).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`${directory}/${name}`);
const native=[
  ...files('api/_lib/assessment'),...files('api/awards'),...files('api/judging'),
  'api/cron/awards.test.mjs','scripts/scopedPostgrest.test.mjs','supabase/migrations/awardsFoundation.test.mjs',
];
const browser=readdirSync('tests').filter(name=>/^awards-.*\.browser\.test\.mjs$/.test(name)).sort().map(name=>`tests/${name}`);
for(const args of [
  ['scripts/run-isolated-tests.mjs','--allow-local-postgrest','--allow-local-postgres','node','--test',...native],
  ['--test','--test-concurrency=1',...browser],
]){
  const result=spawnSync(process.execPath,args,{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0){process.exitCode=result.status??1;break;}
}
