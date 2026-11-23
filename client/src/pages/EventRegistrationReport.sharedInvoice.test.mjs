import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as presentation from '../../../shared/eventInvoiceRecoveryPresentation.mjs';

test('actual report invoice cells and CSV retain checkout identity and invoice mode',async()=>{
  const source=readFileSync(new URL('./EventRegistrationReport.jsx',import.meta.url),'utf8');
  const section=source.slice(source.indexOf('function ReportInvoice('),source.indexOf('function formatAllergySelections('));
  const compiled=await transform(section,{loader:'jsx',format:'cjs'});
  const names=['eventInvoiceId','eventInvoiceNumber','eventInvoiceAwaited','eventInvoiceNeedsAttention','eventInvoiceRetryAt'];
  const {ReportInvoice,reportInvoiceExport}=new Function('React','EventInvoiceStatus','ActivityInvoiceActions','EventFunnelCancellationRecovery',...names,
    `${compiled.code}; return {ReportInvoice,reportInvoiceExport};`)(React,
    ({record})=>React.createElement('span',null,presentation.eventInvoiceNumber(record)),
    ({booking})=>React.createElement('a',{href:`/api/booking-invoice/${booking.booking_group_reference}`},'Download invoice'),
    ({orderId})=>React.createElement('button',{'data-recovery-order':orderId},'Cancellation recovery'),
    ...names.map(name=>presentation[name]));
  for(const mode of ['consolidated','per_event']) {
    const payment={accountingInvoiceId:'original',accountingInvoiceNumber:'INV1',
      sharedCheckout:{orderId:'same-original-checkout',invoiceMode:mode}};
    const html=renderToStaticMarkup(React.createElement(ReportInvoice,{payment,groupRef:'event-group'}));
    assert.match(html,/same-original-checkout/);
    assert.match(html,/\/api\/booking-invoice\/event-group/);
    assert.match(html,/data-recovery-order="same-original-checkout"/);
    assert.match(html,mode==='consolidated'?/Combined invoice/:/Invoice per event/);
    assert.match(reportInvoiceExport(payment),/INV1; Checkout same-original-checkout/);
  }
  assert.equal(reportInvoiceExport({accountingInvoiceNumber:'LEGACY'}),'LEGACY');
});
