// Development-only mounted component fixture. No real session, provider,
// tenant API, or persistence endpoint is contacted.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MemberAiAssistant from '@/components/ai/MemberAiAssistant.jsx';
import { setActiveTenantId } from '@/api/base44Client.js';
import '@/index.css';

if (!import.meta.env.DEV) throw new Error('Member AI fixture is development-only');
setActiveTenantId('fixture-tenant');
const config = {
  tenantId: 'fixture-tenant',
  enabled: true,
  name: 'Fixture Assistant',
  description: 'Isolated UI fixture — not real authentication or provider output',
  avatarUrl: null,
};
const identityKey = 'fixture-tenant:fixture-member';
const sources = [
  { citationId:'S1',type:'resource',sourceId:'fixture-resource',title:'Member handbook',link:'/Resources',sourceGeneration:8 },
  { citationId:'S2',type:'canvas_page',sourceId:'fixture-page',title:'Member welcome page',link:'/partners/welcome',sourceGeneration:3 },
];
const answer = {
  answer:'The handbook explains the approved process [S1]. The member welcome page provides the next steps [S2].',
  sources,answerProvenance:'fixture-only-signed-envelope-not-valid-on-server',
};
const conversation = {id:'fixture-conversation',title:'Approved member guidance',updated_at:new Date().toISOString()};
let messages = [];
let saved = false;
window.__memberAiFixture = {requests:[],persisted:[],answer};
window.fetch = async (input,init={}) => {
  const url = new URL(typeof input==='string' ? input : input.url,location.origin);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  window.__memberAiFixture.requests.push({path:url.pathname,method,body,headers:init.headers});
  let data;
  if (url.pathname.includes('persona') || url.pathname.includes('assistant-settings')) {
    data={name:'Fixture Assistant',description:'Isolated UI fixture — not real authentication or provider output'};
  } else if (url.pathname==='/api/member-ai/ask') {
    data=answer;
  } else if (url.pathname.startsWith('/api/member-ai/conversations')) {
    if (method==='POST') {
      window.__memberAiFixture.persisted.push(body);
      messages.push(...body.messages.map(message=>({
        ...message,...(message.role==='assistant' ? {sources} : {}),
      })));
      saved=true;
      data={conversation};
    } else if (url.pathname.endsWith('/fixture-conversation')) {
      data={conversation,messages};
    } else {
      data={conversations:saved ? [conversation] : []};
    }
  } else {
    throw new Error(`Unexpected fixture network request: ${url.pathname}`);
  }
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
};
const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><MemoryRouter>
    <div style={{position:'fixed',top:4,left:10,zIndex:9999,fontSize:12,background:'#fff',padding:'4px 10px'}}>
      ISOLATED UI FIXTURE · mocked tenant/session, answers and persistence · no real provider
    </div>
    <MemberAiAssistant key={identityKey} identityKey={identityKey} config={config} open onOpenChange={()=>{}} />
  </MemoryRouter></QueryClientProvider>
);