import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {existsSync} from 'node:fs';
import path from 'node:path';
const origin='http://training-speakers.fixture';
let script;
test.beforeAll(async()=>{
  const bundle=await build({
    stdin:{contents:`
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import TrainingAgendaEditor from './client/src/components/events/TrainingAgendaEditor.jsx';
      import {SpeakerAwardsHistoryView} from './client/src/components/SpeakerAwardsHistory.jsx';
      const speaker={id:'speaker',full_name:'Example Speaker'};
      function App(){
        const [lines,setLines]=useState([
          {id:'line-a',start_date:'2027-03-01',description:'First workshop',speaker_ids:['speaker'],item_type:'Workshop'},
          {id:'line-b',start_date:'2027-03-02',description:'Second workshop',speaker_ids:['speaker'],item_type:'Workshop'}
        ]);
        const [legacy,setLegacy]=useState(['speaker']);
        return <><TrainingAgendaEditor isTraining lines={lines} onChange={setLines} speakers={[speaker]}
          agendaItemTypes={[{name:'Workshop',behaviour:'none'}]} legacySpeakerIds={legacy}
          onResolveLegacySpeaker={id=>setLegacy(ids=>ids.filter(sid=>sid!==id))}/>
          <pre data-testid="saved">{JSON.stringify({lines,legacy})}</pre>
          <SpeakerAwardsHistoryView data={{awards:[
            {id:'award-a',event_title:'Training programme',agenda_item_id:'line-a',agenda_description:'First workshop',
              agenda_start_date:'2027-03-01',agenda_end_date:'2027-03-01',agenda_timezone:'Europe/London',status:'active'},
            {id:'award-b',event_title:'Training programme',agenda_item_id:'line-b',agenda_description:'Second workshop',
              agenda_start_date:'2027-03-02',agenda_end_date:'2027-03-02',agenda_timezone:'Europe/London',status:'active'}
          ]}} page={1} setPage={()=>{}} onFile={()=>{}}/>
        </>;
      }
      const q=new QueryClient({defaultOptions:{queries:{retry:false}}});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={q}><App/></QueryClientProvider>);
    `,loader:'jsx',resolveDir:process.cwd()},
    bundle:true,write:false,jsx:'automatic',define:{'process.env.NODE_ENV':'"test"','import.meta.env':'{}'},
    plugins:[{name:'isolated-training',setup(b){
      b.onResolve({filter:/^@\/components\/events\/(EventSponsorSelector|AttendancePolicyEditor|TeamsMeetingConfig|ZoomSessionPicker|ItemCpdPointsField)$/},
        args=>({path:args.path,namespace:'empty'}));
      b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:'export default ()=>null;'}));
      b.onResolve({filter:/^@\/api\/base44Client$/},args=>({path:args.path,namespace:'api'}));
      b.onLoad({filter:/.*/,namespace:'api'},()=>({contents:'export const getActiveTenantId=()=>null; export const base44={entities:{Badge:{list:async()=>[]}}};'}));
      b.onResolve({filter:/^@\//},args=>{
        const base=path.resolve('client/src',args.path.slice(2));
        return {path:[base,`${base}.jsx`,`${base}.js`,`${base}.mjs`].find(existsSync)};
      });
    }}],
  });
  script=bundle.outputFiles[0].text;
});
test('line award editing, explicit legacy allocation, reordering and separate history',async({page})=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin!==origin) return route.abort();
    if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script src="/fixture.js"></script>'});
    if(url.pathname==='/fixture.js') return route.fulfill({contentType:'application/javascript',body:script});
    if(url.pathname==='/api/admin/speakers/certificate-templates') return route.fulfill({json:{templates:[]}});
    if(url.pathname==='/api/admin/speaker-award-eligibility') return route.fulfill({json:{eligibility:{}}});
    throw new Error(`Unexpected fixture request: ${route.request().method()} ${url.pathname}`);
  });
  await page.goto(origin);
  await expect(page.getByTestId('speaker-needs-allocation')).toContainText('2 items selected');
  const first=page.getByTestId('agenda-line-0');
  const second=page.getByTestId('agenda-line-1');
  await first.getByTestId('switch-speaker-awards').click();
  await first.getByTestId('input-award-voucher-value').fill('25');
  await first.getByTestId('input-award-voucher-expiry').fill('2028-01-01');
  await expect(second.getByTestId('switch-speaker-awards')).toHaveAttribute('aria-checked','false');
  await second.getByTestId('switch-speaker-awards').click();
  await second.getByTestId('input-award-voucher-value').fill('50');
  await second.getByTestId('input-award-voucher-expiry').fill('2028-02-01');
  await page.getByRole('button',{name:'Resolve allocation',exact:true}).click();
  await expect(page.getByTestId('speaker-needs-allocation')).toHaveCount(0);
  await page.getByTestId('button-agenda-up-1').click();
  const saved=JSON.parse(await page.getByTestId('saved').textContent());
  expect(saved.lines.map(line=>line.id)).toEqual(['line-b','line-a']);
  expect(saved.lines.map(line=>line.speaker_award_config.default.voucher_value)).toEqual([50,25]);
  expect(saved.legacy).toEqual([]);
  await expect(page.getByTestId('speaker-award-award-a')).toContainText('First workshop');
  await expect(page.getByTestId('speaker-award-award-b')).toContainText('Second workshop');
  expect(errors).toEqual([]);
});
