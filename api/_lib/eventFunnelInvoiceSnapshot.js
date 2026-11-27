import { buildFunnelInvoiceAllocations } from './eventFunnelInvoiceAllocation.js';
import { simpleEventInvoiceLines, complexEventInvoiceLines, invoiceContactPayload,
  invoiceBookerLabel } from './eventInvoiceProducer.js';
import { validRecoverySnapshot, validRecoveryTaxIntent } from './eventInvoiceRecovery.js';

const clone=value=>structuredClone(value);
const fail=message=>{throw Object.assign(new Error(message),{code:'FUNNEL_INVOICE_EVIDENCE_INVALID'});};

/** No mutable catalogue/settings reads and no provider calls. */
export function buildFunnelInvoiceSnapshots(input) {
  const {order}=input,plan=order.snapshot;
  const jobs=buildFunnelInvoiceAllocations(input);
  return jobs.map(job=>{
    if(!job.applicable) return {...job,status:'not_applicable',snapshot:null};
    try {
      if(!/^\d{4}-\d{2}-\d{2}$/.test(plan.invoiceDate || '')
        ||new Date(plan.invoiceDate).toISOString().slice(0,10)!==plan.invoiceDate) fail('Original invoice date is missing');
      const contexts=job.events.flatMap(event=>event.registrationLines.filter(line=>line.payableMinor>0)
        .map(line=>line.priceSnapshot?.commercial));
      const context=contexts[0],provider=context?.accounting,settings=context?.accountingSettings;
      if(!provider?.connectionId||!provider.company||!settings
        ||contexts.some(value=>JSON.stringify(value.accounting)!==JSON.stringify(provider))) fail('Original accounting company is missing or inconsistent');
      const lineAllocations=[];
      const lines=job.events.flatMap(event=>event.registrationLines.filter(line=>line.payableMinor>0).flatMap(line=>{
        const price=line.priceSnapshot;
        const accountCode=price.accountCode || settings.xero_sales_account_code || '200';
        const ticket={id:line.ticketId,name:price.ticketName,vat_rate_key:price.tax?.key,
          vat_rate_percentage:price.tax?.percentage,invoice_line_amount_type:price.tax?.lineAmountType};
        if(price.tax?.lineAmountType!=='Inclusive') fail('Original checkout tax policy is missing');
        const eventData={title:price.eventTitle,internal_reference:price.eventReference,
          pricing_config:{ticket_classes:[ticket]}};
        const attendee=row=>({first_name:row.row?.attendee_first_name,last_name:row.row?.attendee_last_name,
          email:row.row?.attendee_email});
        return line.registrations.flatMap(row=>{
          const rendered=event.eventKind==='simple'?simpleEventInvoiceLines({
            event:eventData,bookingAttendees:[attendee(row)],ticketsRequired:1,
            ticketClassName:price.ticketName,ticketClassPrice:price.unitAmount ?? price.unitMinor/100,
            ticketClassId:line.ticketId,totalCost:row.grossMinor/100,
            voucherAmountApplied:row.voucherMinor/100,validatedTrainingFundAmount:row.trainingFundMinor/100,
            validatedRemainingBalance:row.payableMinor/100,
            pricingDetails:row.discountMinor>0?{discountAmount:row.discountMinor/100}:undefined,
          },accountCode):complexEventInvoiceLines({
          event:eventData,resolvedItems:[{
            attendees:[attendee(row)],serverTicket:ticket,ticketClass:ticket,authoritativePrice:row.grossMinor/100,
          }],actualVoucherApplied:row.voucherMinor/100,actualTfApplied:row.trainingFundMinor/100,
        },accountCode);
          // Complex lines are priced after the code, so name the saving.
          const code=plan.discounts?.[0]?.code;
          if(event.eventKind!=='simple'&&row.discountMinor>0&&rendered[0]) {
            rendered[0].Description+=`\nDiscount${code?` (${code})`:''}: -£${(row.discountMinor/100).toFixed(2)}`;
          }
          for(const renderedLine of rendered){
            renderedLine.Description=`Booking reference: ${row.row?.booking_reference||row.id}\n${renderedLine.Description}`;
            lineAllocations.push({index:lineAllocations.length,source:event.bookingSource,bookingId:row.id,eventId:event.eventId,
              nodeId:line.nodeId,ticketId:line.ticketId,amountMinor:Math.round(renderedLine.Quantity*renderedLine.UnitAmount*100)});
          }
          return rendered;
        });
      }));
      const label=invoiceBookerLabel(plan.purchaser);
      const organization=plan.invoiceCustomer?.organizationReference;
      if(lines.length) lines[0].Description=[
        label,organization ? `Organisation reference: ${organization}` : null,lines[0].Description,
      ].filter(Boolean).join('\n\n');
      const stripped=lines.map(({_invoiceLineAmountType,_checkoutTaxPercentage,...line})=>line);
      if(stripped.reduce((sum,line)=>sum+Math.round(line.Quantity*line.UnitAmount*100),0)!==job.amountMinor) {
        fail('Frozen invoice total does not match allocated payment');
      }
      if(!plan.invoiceCustomer?.name||!plan.invoiceCustomer?.provenance) fail('Original accounting customer is missing');
      const due=new Date(`${plan.invoiceDate}T00:00:00Z`);due.setUTCDate(due.getUTCDate()+30);
      const charge=order.verified_payment?.capturedCharge;
      let settlement=null;
      if(job.paymentMethod==='card') {
        if(!charge||charge.amountMinor!==order.payable_minor||charge.currency!==job.currency
          ||charge.livemode!==true||!Number.isFinite(Date.parse(charge.paidAt))) fail('Captured live charge evidence requires review');
        settlement={...job.settlement,paymentIntentId:order.payment_intent_id,status:'succeeded',
          amount:job.amountMinor/100,currency:job.currency,paidAt:charge.paidAt,chargeId:charge.id,
          amountReceived:order.payable_minor,captured:true,livemode:true,
          accountCode:settings.xero_stripe_bank_account_code};
      }
      if(provider.name==='xero') {
        const snapshot={
          version:1,bookingContractVersion:2,contact:clone(job.contact),booker:clone(plan.purchaser),
          currency:job.currency,amount:job.amountMinor/100,paymentMethod:settlement?'stripe':'invoice',
          checkoutPaymentMethod:job.paymentMethod,purchaseOrderNumber:plan.purchaseOrderNumber || null,
          provider:{name:'xero',connectionId:provider.connectionId,xeroTenantId:provider.company},
          eventFunnel:{version:1,orderId:job.orderId,allocationKey:job.key,invoiceMode:job.invoiceMode,
            lineAllocations:clone(lineAllocations),
            events:job.events.map(event=>({eventId:event.eventId,source:event.bookingSource,bookingIds:event.bookingIds,
              amountMinor:event.payableMinor}))},
          settlement,invoice:{
            Type:'ACCREC',Contact:invoiceContactPayload(job.contact),Date:plan.invoiceDate,
            DueDate:due.toISOString().slice(0,10),CurrencyCode:job.currency,LineAmountTypes:'Inclusive',
            LineItems:stripped,Reference:plan.purchaseOrderNumber || 'TBC',
            Status:settlement?'AUTHORISED':settings.xero_invoice_status || 'DRAFT',
          },
        };
        if(stripped.some(line=>!line.TaxType||!Number.isFinite(line.TaxAmount))) {
          snapshot.taxResolution={version:1,kind:'future_checkout_provider_tax',capturedAt:`${plan.invoiceDate}T00:00:00.000Z`};
        }
        if(!validRecoverySnapshot(snapshot)&&!validRecoveryTaxIntent(snapshot)) fail('Original invoice tax or payment evidence requires review');
        return {...job,provider:'xero',status:'pending',snapshot};
      }
      if(provider.name!=='quickbooks'||!['production','sandbox'].includes(provider.environment)) fail('Unsupported original accounting provider');
      // Provider-neutral financial lines, never reinterpret a Xero ledger code
      // as a QuickBooks ItemRef. The shared queue resolves the captured mapping.
      const snapshot={
        version:1,preparation:true,bookingContractVersion:2,environment:provider.environment,
        approvalProvider:{connectionId:provider.connectionId,realmId:provider.company},
        invoice:{amount:job.amountMinor/100,currency:job.currency,paymentMethod:settlement?'stripe':'invoice',
          contact:clone(job.contact),booker:clone(plan.purchaser),capturedAt:`${plan.invoiceDate}T00:00:00.000Z`,
          date:plan.invoiceDate,dueDate:due.toISOString().slice(0,10),reference:plan.purchaseOrderNumber || 'TBC',
          settings:Object.fromEntries(['quickbooks_event_item_id','quickbooks_event_tax_code_id',
            'quickbooks_event_stripe_bank_account_id'].map(key=>[key,settings[key] || null])),
          lines:lines.map(line=>({...line,AccountCode:'__quickbooks_event_item__'}))},
        payment:settlement ? {...settlement,accountCode:'pending_event_mapping'} : null,
        linkage:{source:'event_funnel',group:job.key,orderId:job.orderId,
          lineAllocations:clone(lineAllocations),
          events:job.events.map(event=>({eventId:event.eventId,source:event.bookingSource,bookingIds:event.bookingIds}))},
      };
      return {...job,provider:'quickbooks',status:'pending',snapshot};
    } catch(error) {
      // Keep the original allocations; do not fall back to current settings or
      // the other accounting provider after a failed preparation.
      return {...job,status:'needs_review',snapshot:null,reason:'Original invoice preparation requires review'};
    }
  });
}
