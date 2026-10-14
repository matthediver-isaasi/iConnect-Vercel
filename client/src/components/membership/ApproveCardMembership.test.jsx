import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
globalThis.React = React;
const dom=new JSDOM("<html><body><div id='root'></div></body></html>",{url:"http://localhost/"});
for(const key of ["window","document","navigator","HTMLElement","HTMLInputElement","Element","Node","NodeFilter","CustomEvent","MutationObserver","getComputedStyle"])
  Object.defineProperty(globalThis,key,{value:key==="getComputedStyle"?dom.window.getComputedStyle: key==="window"?dom.window:dom.window[key],configurable:true,writable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {default:ApproveCardMembership}=await import("./ApproveCardMembership.jsx");
const record={id:"h",status:"pending_activation",payment_method:"card_monthly",payment_status:"partial"};
test("only an authorised admin sees approval on a paid, pending personal card membership",()=>{
  for(const [allowed,patch,visible] of [[true,{},true],[false,{},false],
    [true,{payment_status:"unpaid"},false],[true,{status:"active"},false],
    [true,{payment_method:"direct_debit"},false],[true,{membership_source:"organisation"},false]]) {
    const client=new QueryClient({defaultOptions:{queries:{gcTime:0},mutations:{gcTime:0}}});
    try {
      const html=renderToStaticMarkup(React.createElement(QueryClientProvider,{client},
        React.createElement(ApproveCardMembership,{memberId:"m",record:{...record,...patch},allowed})));
      assert.equal(html.includes("Activate membership"),visible);
    } finally {client.clear();}
  }
});
test("confirmation submits once, closes and invalidates membership data",async()=>{
  const {createRoot}=await import("react-dom/client");
  const client=new QueryClient({defaultOptions:{queries:{gcTime:0},mutations:{gcTime:0}}});
  const root=createRoot(document.getElementById("root"));
  const originalFetch=globalThis.fetch;let calls=0,invalidations=0;
  client.invalidateQueries=async()=>{invalidations++;};
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(url,"/api/membership/member-membership");
    assert.deepEqual(JSON.parse(options.body),{action:"approve_card_membership",memberId:"m",historyId:"h"});
    return {ok:true,json:async()=>({ok:true,detail:"Membership activated"})};
  };
  try{
    await React.act(async()=>root.render(React.createElement(QueryClientProvider,{client},
      React.createElement(ApproveCardMembership,{memberId:"m",record,allowed:true}))));
    await React.act(async()=>document.querySelector("button").click());
    assert.equal(calls,0);assert.ok(document.querySelector('[role="dialog"]'));
    await React.act(async()=>{
      [...document.querySelectorAll("button")].find(b=>b.textContent==="Approve membership").click();
      await new Promise(r=>setTimeout(r,30));
    });
    assert.equal(calls,1);assert.equal(invalidations,3);assert.equal(document.querySelector('[role="dialog"]'),null);
  }finally{await React.act(async()=>root.unmount());client.clear();globalThis.fetch=originalFetch;dom.window.close();}
});
