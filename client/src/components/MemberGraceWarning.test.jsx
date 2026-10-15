import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import MemberGraceWarning from './MemberGraceWarning';
globalThis.React=React;
function render(data){
  const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
  client.setQueryData(['member-membership','member'],data);
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><MemberGraceWarning memberId="member" enabled /></QueryClientProvider>);
  client.clear();return html;
}
test('amber grace warning shows days elapsed, remaining and UK end date',()=>{
  const html=render({graceWarning:{expired:false,days:8,remainingDays:22,endsOn:'2026-10-31',reason:'Upfront membership has not yet been renewed.'}});
  for(const value of ['bg-amber-50','8 days since grace began','22 grace days remaining','31/10/2026']) assert.ok(html.includes(value));
});
test('exhausted and zero-grace warnings are red with distinct headings',()=>{
  const warning={expired:true,days:40,endsOn:'2026-10-01',reason:'Not renewed'};
  assert.match(render({graceWarning:warning}),/Grace period expired/);
  const html=render({graceWarning:{...warning,noGrace:true}});
  assert.match(html,/bg-red-50/);assert.match(html,/Membership expired/);
  assert.match(html,/No grace period applies/);
});
test('missing policy and failed checks remain visible without invented dates',()=>{
  const html=render({graceWarning:{policyUnknown:true,reason:'Policy unavailable'}});
  assert.match(html,/Membership expiry status needs checking/);assert.doesNotMatch(html,/Invalid Date|undefined/);
  assert.match(render({graceWarningUnavailable:true}),/could not be checked/);
  assert.equal(render({graceWarning:null}),'');
});
