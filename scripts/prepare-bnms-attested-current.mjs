#!/usr/bin/env node
// Builds a review manifest only. Missing invoice evidence remains explicitly
// unlinked and unpriced; the paid status is the operator's instruction.
import { readFile, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { inventory } from './audit-bnms-non-dd-cohort.mjs';
import { TENANT } from './audit-bnms-non-dd-pilot.mjs';
import { AS_OF, digest, recordId } from './prepare-bnms-non-dd-current.mjs';
import { canonicalHash, validateManifest } from './bnms-non-dd-apply.mjs';

export const REVIEW_STATES = new Set([
  'invoice_term_unconfirmed','missing_or_ambiguous_contact','invoice_period_conflict',
  'equal_date_or_missing_date_ambiguity','missing_paid_membership_invoice',
  'financial_or_mixed_invoice_conflict','payment_detail_conflict',
]);
export function attestedManifest(snapshot, report) {
  if(report?.writes!==0||report.manifest?.sourceHash!==snapshot.sourceHash
    ||report.manifest?.tenantId!==TENANT||report.manifest?.asOf!==AS_OF
    ||!Array.isArray(report.reviews)||report.selected!==report.reviews.length
    ||report.manifest.rows.length)throw Error('Complete matching zero-write unresolved-invoice review required');
  const selected=snapshot.candidates.filter(r=>r.category==='requires_term_and_invoice_review'
    &&r.expiry>=AS_OF&&r.expiry<='2026-12-31');
  if(selected.length!==report.selected||new Set(report.reviews.map(r=>r.memberId)).size!==selected.length
    ||report.reviews.some(r=>!REVIEW_STATES.has(r.state)||!selected.some(c=>c.id===r.memberId))) {
    throw Error('Reviewed cohort changed or contains an unsupported result');
  }
  const manifest={version:1,tenantId:TENANT,asOf:AS_OF,sourceHash:snapshot.sourceHash,rows:[],evidence:[]};
  for(const candidate of selected){
    const review=report.reviews.find(r=>r.memberId===candidate.id);
    const sourceHash=digest(candidate);
    const notes={
      source:'bnms_non_dd_current_backfill',version:1,sourceHash,
      paymentAuthority:'operator_attested_upfront_paid_2025_2026',
      startDateAuthority:'unknown_not_inferred',expiryAuthority:'retained_legacy_expiry',
      termAuthority:'operator_attested_existing_2025_2026',
      invoiceReviewState:review.state,invoiceAuthority:'unresolved_not_linked',
      historicalAmountAuthority:'unknown_not_inferred',legacy:candidate.preferences,
    };
    manifest.rows.push({
      id:recordId(candidate.id),tenant_id:TENANT,member_id:candidate.id,membership_year:'2025/2026',
      config_id:null,tier_label:candidate.preferences.ym_membership_type,
      term_start_date:null,term_end_date:candidate.expiry,status:'active',payment_status:'paid',
      final_cost:null,total_with_vat:null,currency:'GBP',payment_method:'upfront',billing_period:'annual',
      accounting_provider:null,accounting_invoice_id:null,accounting_invoice_number:null,
      xero_invoice_id:null,xero_invoice_number:null,notes:JSON.stringify(notes),
    });
    manifest.evidence.push({memberId:candidate.id,sourceHash});
  }
  return validateManifest(manifest);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  if(args.length!==2||!args.every(a=>a.startsWith('/tmp/')))throw Error('Usage: script /tmp/review.json /tmp/new-manifest.json');
  const manifest=attestedManifest(await inventory(),JSON.parse(await readFile(args[0],'utf8')));
  const out=await open(args[1],'wx',0o600);
  try{await out.writeFile(JSON.stringify(manifest,null,2));}finally{await out.close();}
  console.log(JSON.stringify({mode:'review_only',rows:manifest.rows.length,hash:canonicalHash(manifest),writes:0}));
}