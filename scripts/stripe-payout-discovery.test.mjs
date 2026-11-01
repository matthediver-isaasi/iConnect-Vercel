import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('Stripe payout report is available in the portal menu and role catalogue',()=>{
  const picker=fs.readFileSync('client/src/pages/PortalMenuManagement.jsx','utf8');
  assert.match(picker,/\{ value: "StripePayoutReport", label: "Stripe Payout Reconciliation" \}/);
  const roles=fs.readFileSync('client/src/lib/roleAccessMap.ts','utf8');
  assert.match(roles,/id: "commerce\.stripe-payout-report"/);
  assert.match(roles,/"page_StripePayoutReport": "commerce\.stripe-payout-report"/);
  const migration=fs.readFileSync('supabase/migrations/20261208_stripe_payout_role_catalogue.sql','utf8');
  assert.match(migration,/INSERT INTO public\.role_access_item/);
  assert.match(migration,/'commerce.stripe-payout-report','Stripe Payout Reconciliation'/);
  assert.doesNotMatch(migration,/UPDATE\s+(?:public\.)?role\s|excluded_features\s*=/i);
});
