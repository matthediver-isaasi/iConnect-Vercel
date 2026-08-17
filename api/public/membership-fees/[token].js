import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    const { data: feeToken, error: tokenError } = await supabase
      .from('membership_fee_token')
      .select('*')
      .eq('token', token)
      .single();

    if (tokenError || !feeToken) {
      return res.status(404).json({ error: 'Fee link not found or has expired' });
    }

    if (new Date(feeToken.expires_at) < new Date()) {
      if (feeToken.status === 'pending') {
        await supabase
          .from('membership_fee_token')
          .update({ status: 'expired' })
          .eq('id', feeToken.id);
      }
      return res.status(410).json({ error: 'This fee link has expired' });
    }

    if (feeToken.status === 'cancelled') {
      return res.status(410).json({ error: 'This fee link has been cancelled' });
    }

    // Task #3211 — member-driven fee tokens (workflow "Create Membership"
    // on member-scoped tier structures) carry member_id instead of
    // organization_id. Their approval checks, history table, notes and
    // Direct Debit option all branch on this flag.
    const isMemberToken = !!feeToken.member_id;
    let tokenMember = null;
    if (isMemberToken) {
      const { data: m } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, tenant_id, organization_id')
        .eq('id', feeToken.member_id)
        .maybeSingle();
      tokenMember = m || null;
    }
    const memberDisplayName = tokenMember
      ? (`${tokenMember.first_name || ''} ${tokenMember.last_name || ''}`.trim() || tokenMember.email || 'Member')
      : null;

    // Shared approval gate: when membership_require_approval is on, fees
    // must be approved on the entity's invoicing row before payment.
    const checkApprovalBlocked = async () => {
      try {
        const { data: approvalSetting } = await supabase
          .from('system_settings')
          .select('setting_value')
          .eq('setting_key', 'membership_require_approval')
          .eq('tenant_id', feeToken.tenant_id)
          .maybeSingle();
        if (approvalSetting?.setting_value !== 'true') return false;
        const table = isMemberToken ? 'member_membership_invoicing' : 'organisation_membership_invoicing';
        let q = supabase
          .from(table)
          .select('fees_approved')
          .eq('tenant_id', feeToken.tenant_id)
          .eq('membership_year', feeToken.membership_year);
        q = isMemberToken ? q.eq('member_id', feeToken.member_id) : q.eq('organization_id', feeToken.organization_id);
        const { data: invoicing } = await q.maybeSingle();
        return !invoicing?.fees_approved;
      } catch {
        return false;
      }
    };

    if (req.method === 'GET') {
      const { data: org } = isMemberToken
        ? { data: { name: memberDisplayName } }
        : await supabase
            .from('organization')
            .select('name')
            .eq('id', feeToken.organization_id)
            .single();

      let tenantBranding = null;
      try {
        const { data: tenant } = await supabase
          .from('tenant')
          .select('name, slug, logo_url, primary_color, secondary_color')
          .eq('id', feeToken.tenant_id)
          .single();
        tenantBranding = tenant;
      } catch {}

      let stripePublishableKey = null;
      let tierConfig = null;
      try {
        const { getConfigForOrganisation, getConfigForMember } = await import('../../_lib/membershipConfigResolver.js');
        tierConfig = isMemberToken
          ? await getConfigForMember(feeToken.tenant_id, feeToken.member_id)
          : await getConfigForOrganisation(feeToken.tenant_id, feeToken.organization_id);
        if (tierConfig?.online_card_payment) {
          const { getStripeCredentials } = await import('../../_lib/stripeCredentials.js');
          const creds = await getStripeCredentials(feeToken.tenant_id, 'membership');
          if (creds?.is_enabled && creds?.publishable_key) {
            stripePublishableKey = creds.publishable_key;
          }
        }
      } catch {}

      const breakdown = feeToken.cost_breakdown || {};

      if (breakdown.freeDiscount > 0 && !breakdown.freePeriodUnit) {
        try {
          const { simulateMembershipForOrg, simulateMembershipForMember } = await import('../../_lib/membershipSimulation.js');
          const simResult = isMemberToken
            ? await simulateMembershipForMember(feeToken.tenant_id, feeToken.member_id, {
                source: 'token-enrich',
                targetYear: feeToken.membership_year,
              })
            : await simulateMembershipForOrg(feeToken.tenant_id, feeToken.organization_id, {
                source: 'token-enrich',
                targetYear: feeToken.membership_year,
              });
          if (simResult.success) {
            breakdown.freePeriodUnit = simResult.freePeriodUnit;
            breakdown.freePeriodAmount = simResult.freePeriodAmount;
            breakdown.yearNumber = simResult.yearNumber;
            if (!breakdown.freePeriodDaysApplied) {
              breakdown.freePeriodDaysApplied = simResult.freePeriodDaysApplied || 0;
            }
          }
        } catch {}
      }

      const tokenVatRate = breakdown.vatRatePercent || null;
      const tokenVatAmount = breakdown.vatAmount || 0;
      const tokenTotalWithVat = breakdown.totalWithVat || parseFloat(feeToken.final_cost);

      // Add-on lines (Training Fund top-ups, freeform) shown on the fee
      // summary. New tokens carry a display-ready list in the stored
      // breakdown. Older tokens don't — for those, resolve the invoicing
      // record's add-on lines server-side, but ONLY when the linked history
      // record confirms the add-ons are baked into its totals (otherwise the
      // rows wouldn't reconcile to the token's total).
      let addonLines = Array.isArray(breakdown.addonLines) ? breakdown.addonLines : null;
      if (!addonLines && feeToken.history_record_id && !isMemberToken) {
        try {
          const { data: hist } = await supabase
            .from('organisation_membership_history')
            .select('notes, final_cost')
            .eq('id', feeToken.history_record_id)
            .maybeSingle();
          if (hist && /add-on line\(s\) included/.test(hist.notes || '')
            && Math.abs(parseFloat(hist.final_cost) - parseFloat(feeToken.final_cost)) < 0.005) {
            const { loadAddonLines, buildAddonDisplayLines } = await import('../../_lib/membershipAddons.js');
            const stored = await loadAddonLines(feeToken.tenant_id, feeToken.organization_id, feeToken.membership_year);
            if (stored.length > 0) addonLines = buildAddonDisplayLines(stored);
          }
        } catch {}
      }
      if (addonLines && addonLines.length > 0) breakdown.addonLines = addonLines;

      // If the token carries a pre-created Xero invoice id but no online URL
      // yet (e.g. the cron created the invoice but the URL fetch failed at
      // the time, or the invoice was in DRAFT and has since been authorised),
      // try once more to resolve the online URL so we can show it on the
      // confirmation screen.
      let xeroOnlineInvoiceUrl = feeToken.xero_online_invoice_url || null;
      if (feeToken.xero_invoice_id && !xeroOnlineInvoiceUrl) {
        try {
          const { getAccountingProvider } = await import('../../_lib/accountingProvider.js');
          const _provider = await getAccountingProvider(feeToken.tenant_id);
          const { accessToken, tenantId: xeroTenantId } = await _provider.getRawAccessToken(feeToken.tenant_id);
          const r = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${feeToken.xero_invoice_id}/OnlineInvoice`, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'xero-tenant-id': xeroTenantId, 'Accept': 'application/json' },
          });
          if (r.ok) {
            const d = await r.json();
            xeroOnlineInvoiceUrl = d?.OnlineInvoices?.[0]?.OnlineInvoiceUrl || null;
            if (xeroOnlineInvoiceUrl) {
              await supabase.from('membership_fee_token').update({ xero_online_invoice_url: xeroOnlineInvoiceUrl, updated_at: new Date().toISOString() }).eq('id', feeToken.id);
            }
          }
        } catch {}
      }

      // Direct Debit option (member tokens only): offered when the member's
      // tier has DD enabled with a resolvable monthly amount AND the tenant
      // has GoCardless credentials. Also surfaces any in-flight agreement so
      // the page can show progress after the hosted-flow redirect.
      let ddEnabled = false;
      let ddOffer = null;
      let ddStatus = null;
      let cardMonthly = null;
      let cardStatus = null;
      let openPlan = null;
      let renewal = null;
      if (isMemberToken && tokenMember) {
        // Monthly card option (Task #3620): offered when the tier enables it
        // AND the tenant has usable Stripe membership credentials.
        try {
          if (tierConfig?.card_monthly_enabled) {
            const { getStripeCredentials } = await import('../../_lib/stripeCredentials.js');
            const stripeCreds = await getStripeCredentials(feeToken.tenant_id, 'membership');
            if (stripeCreds?.secret_key) {
              const { simulateMembershipForMember } = await import('../../_lib/membershipSimulation.js');
              const { resolveCardMonthlyOffer } = await import('../../_lib/stripeMonthlyCard.js');
              const cardSim = await simulateMembershipForMember(feeToken.tenant_id, feeToken.member_id, {
                source: 'token-card-monthly',
                mode: 'manual',
                targetYear: feeToken.membership_year,
              });
              const offer = resolveCardMonthlyOffer(cardSim);
              if (offer) {
                cardMonthly = {
                  monthlyAmount: offer.monthlyAmount,
                  instalmentCount: offer.instalmentCount,
                  planTotal: offer.planTotal,
                  currency: offer.currency,
                };
              }
            }
          }
        } catch (cardErr) {
          console.warn('[Public Fee] Card-monthly availability check failed (non-fatal):', cardErr.message);
        }
        try {
          const { getGocardlessCredentials } = await import('../../_lib/gocardlessCredentials.js');
          const creds = await getGocardlessCredentials(feeToken.tenant_id);
          if (creds?.accessToken && tierConfig?.dd_enabled) {
            const { simulateMembershipForMember } = await import('../../_lib/membershipSimulation.js');
            const { resolveDdOffer } = await import('../../_lib/gocardlessDirectDebit.js');
            const ddSim = await simulateMembershipForMember(feeToken.tenant_id, feeToken.member_id, {
              source: 'token-dd',
              mode: 'manual',
              targetYear: feeToken.membership_year,
            });
            const offer = resolveDdOffer(ddSim);
            if (offer) {
              ddEnabled = true;
              ddOffer = {
                monthlyAmount: offer.monthlyAmount,
                instalmentCount: offer.instalmentCount,
                planTotal: offer.planTotal,
                currency: offer.currency,
              };
            }
          }
          const { data: agreements } = await supabase
            .from('membership_billing_agreements')
            .select('id, status, provider, gocardless_mandate_id, stripe_subscription_id, created_at')
            .eq('tenant_id', feeToken.tenant_id)
            .eq('member_id', feeToken.member_id)
            .order('created_at', { ascending: false })
            .limit(5);
          const latestGc = (agreements || []).find((a) => (a.provider || 'gocardless') !== 'stripe');
          if (latestGc) {
            ddStatus = { status: latestGc.status, hasMandate: !!latestGc.gocardless_mandate_id };
          }
          const latestCard = (agreements || []).find((a) => a.provider === 'stripe');
          if (latestCard) {
            cardStatus = { status: latestCard.status, hasSubscription: !!latestCard.stripe_subscription_id };
          }
          // Provider-independent open-plan flag for THIS membership year — the
          // page uses it to suppress the one-off annual "Pay Now" option
          // (server-side create_payment guard remains authoritative).
          const { findOpenAgreementForYear } = await import('../../membership/monthly-card.js');
          const open = await findOpenAgreementForYear({
            tenantId: feeToken.tenant_id,
            memberId: feeToken.member_id,
            yearLabel: feeToken.membership_year,
          });
          if (open) openPlan = { provider: open.provider || 'gocardless', status: open.status };
        } catch (ddErr) {
          console.warn('[Public Fee] DD availability check failed (non-fatal):', ddErr.message);
        }
        // Task #3621 — renewal state for THIS membership year (DD or card):
        // lets the page show "awaiting your confirmation" / "renewal failed —
        // pay with an up-to-date card" states.
        try {
          const { data: renewalRow } = await supabase
            .from('membership_dd_renewals')
            .select('status, mode, failure_reason, previous_agreement_id')
            .eq('tenant_id', feeToken.tenant_id)
            .eq('member_id', feeToken.member_id)
            .eq('renewal_year', feeToken.membership_year)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (renewalRow) {
            let provider = 'gocardless';
            try {
              const { data: prevAgree } = await supabase
                .from('membership_billing_agreements')
                .select('provider')
                .eq('id', renewalRow.previous_agreement_id)
                .maybeSingle();
              if (prevAgree?.provider === 'stripe') provider = 'stripe';
            } catch {}
            renewal = {
              status: renewalRow.status,
              mode: renewalRow.mode,
              provider,
              failureReason: renewalRow.failure_reason || null,
            };
          }
        } catch (renewErr) {
          console.warn('[Public Fee] Renewal state lookup failed (non-fatal):', renewErr.message);
        }
      }

      return res.json({
        status: feeToken.status,
        isMember: isMemberToken,
        memberName: memberDisplayName,
        ddEnabled,
        ddOffer,
        ddStatus,
        cardMonthlyEnabled: !!cardMonthly,
        cardMonthly,
        cardStatus,
        openPlan,
        renewal,
        organizationName: org?.name || 'Organisation',
        membershipYear: feeToken.membership_year,
        finalCost: parseFloat(feeToken.final_cost),
        vatRatePercent: tokenVatRate,
        vatAmount: tokenVatAmount,
        totalWithVat: tokenTotalWithVat,
        currency: feeToken.currency || 'GBP',
        tierLabel: feeToken.tier_label,
        costBreakdown: breakdown,
        addonLines: addonLines && addonLines.length > 0 ? addonLines : [],
        poNumber: feeToken.po_number || null,
        stripeEnabled: !!stripePublishableKey,
        stripePublishableKey,
        xeroInvoiceNumber: feeToken.xero_invoice_number || null,
        xeroOnlineInvoiceUrl,
        tenant: tenantBranding ? {
          name: tenantBranding.name,
          logoUrl: tenantBranding.logo_url,
          primaryColor: tenantBranding.primary_color || '#5C0085',
        } : null,
        ...(await (async () => {
          try {
            const blocked = await checkApprovalBlocked();
            if (!blocked) return { approvalPending: false, approvalMessage: null };
            const { data: msgSetting } = await supabase.from('system_settings').select('setting_value').eq('setting_key', 'membership_custom_message').eq('tenant_id', feeToken.tenant_id).maybeSingle();
            return { approvalPending: true, approvalMessage: msgSetting?.setting_value || null };
          } catch { return { approvalPending: false, approvalMessage: null }; }
        })()),
      });
    }

    if (req.method === 'POST') {
      const { action } = req.body;

      // Task #1112 — confirm_payment must be able to recover a stuck-paid
      // token (status='paid' but no history row). Skip the "already paid"
      // short-circuit for that action and let its own idempotency probe
      // (further down) decide whether to return success or surface a 409.
      if (feeToken.status === 'paid' && action !== 'confirm_payment') {
        return res.status(400).json({ error: 'This membership fee has already been paid' });
      }

      if (action === 'submit_po') {
        const { poNumber } = req.body;
        if (!poNumber || !poNumber.trim()) {
          return res.status(400).json({ error: 'Purchase order number is required' });
        }

        if (await checkApprovalBlocked()) {
          return res.status(400).json({ error: 'Fees have not yet been approved. Please contact your administrator.' });
        }

        const { error: updateError } = await supabase
          .from('membership_fee_token')
          .update({
            po_number: poNumber.trim(),
            status: 'po_submitted',
            updated_at: new Date().toISOString(),
          })
          .eq('id', feeToken.id);

        if (updateError) {
          console.error('[Public Fee] Error updating PO:', updateError);
          return res.status(500).json({ error: 'Failed to save purchase order number' });
        }

        let poSyncWarning = null;
        const invoicingTable = isMemberToken ? 'member_membership_invoicing' : 'organisation_membership_invoicing';
        const entityColumn = isMemberToken ? 'member_id' : 'organization_id';
        const entityId = isMemberToken ? feeToken.member_id : feeToken.organization_id;
        try {
          try {
            await supabase.rpc('exec_sql', {
              sql_text: `
                ALTER TABLE ${invoicingTable} ADD COLUMN IF NOT EXISTS purchase_order_number TEXT;
                ALTER TABLE ${invoicingTable} ADD COLUMN IF NOT EXISTS membership_year TEXT;
                ALTER TABLE ${invoicingTable} ADD COLUMN IF NOT EXISTS po_source TEXT;
              `
            });
          } catch (colErr) {
            console.warn('[Public Fee] exec_sql unavailable for column ensure:', colErr?.message || colErr);
          }

          const { data: existingInvoicing, error: lookupErr } = await supabase
            .from(invoicingTable)
            .select('id')
            .eq('tenant_id', feeToken.tenant_id)
            .eq(entityColumn, entityId)
            .eq('membership_year', feeToken.membership_year)
            .maybeSingle();

          if (lookupErr) {
            console.error('[Public Fee] Error looking up invoicing row:', lookupErr);
            poSyncWarning = 'PO number saved on token but could not sync to admin invoicing tab. The admin may need to add the purchase_order_number column manually.';
          } else if (existingInvoicing) {
            const { error: updErr } = await supabase
              .from(invoicingTable)
              .update({ purchase_order_number: poNumber.trim(), po_source: 'member', updated_at: new Date().toISOString() })
              .eq('id', existingInvoicing.id);
            if (updErr) {
              console.error('[Public Fee] Error updating PO on invoicing row:', updErr);
              poSyncWarning = 'PO number saved on token but failed to sync to admin invoicing tab.';
            }
          } else {
            const { error: insErr } = await supabase
              .from(invoicingTable)
              .insert({
                tenant_id: feeToken.tenant_id,
                [entityColumn]: entityId,
                membership_year: feeToken.membership_year,
                invoicing_mode: 'manual',
                purchase_order_number: poNumber.trim(),
                po_source: 'member',
              });
            if (insErr) {
              console.error('[Public Fee] Error inserting invoicing row with PO:', insErr);
              poSyncWarning = 'PO number saved on token but failed to sync to admin invoicing tab.';
            }
          }
        } catch (syncErr) {
          console.error('[Public Fee] Error syncing PO to invoicing:', syncErr);
          poSyncWarning = 'PO number saved on token but could not sync to admin invoicing tab.';
        }

        // If the token carries a pre-created Xero invoice id (cron-created
        // auto-renewal path, Task #990), push the submitted PO into the Xero
        // invoice's Reference field so finance sees it on the invoice itself.
        let xeroPoWarning = null;
        if (feeToken.xero_invoice_id) {
          try {
            const { getAccountingProvider } = await import('../../_lib/accountingProvider.js');
            const _provider = await getAccountingProvider(feeToken.tenant_id);
            const reference = `Membership ${feeToken.membership_year} - PO: ${poNumber.trim()}`;
            const xeroResult = await _provider.pushPurchaseOrder({
              appTenantId: feeToken.tenant_id,
              xeroInvoiceId: feeToken.xero_invoice_id,
              purchaseOrderNumber: reference,
              contextLabel: 'Public Fee PO',
            });
            if (!xeroResult.xeroUpdated && xeroResult.xeroError) {
              xeroPoWarning = `PO saved but could not be pushed to Xero invoice: ${xeroResult.xeroError}`;
            }
          } catch (xeroErr) {
            console.error('[Public Fee] Xero PO push failed:', xeroErr.message);
            xeroPoWarning = 'PO saved but could not be pushed to Xero invoice.';
          }
        }

        // Mirror PO onto the membership history record so admin views show it.
        if (feeToken.history_record_id) {
          try {
            await supabase
              .from(isMemberToken ? 'member_membership_history' : 'organisation_membership_history')
              .update({ purchase_order_number: poNumber.trim() })
              .eq('id', feeToken.history_record_id);
          } catch (histErr) {
            console.warn('[Public Fee] history PO update failed:', histErr.message);
          }
        }

        // Downstream the submitted PO to any training fund purchases billed on
        // the same invoice (add-on flow) so they drop off the pending PO
        // report. The token's xero_invoice_id column holds whichever
        // provider's invoice id was minted (legacy name); Xero purchases key
        // on xero_invoice_id while QuickBooks purchases only carry
        // accounting_invoice_id, so match both columns with two updates
        // (PostgREST .or() is unreliable on UPDATE). Non-fatal on error.
        if (feeToken.xero_invoice_id) {
          const invoiceId = String(feeToken.xero_invoice_id);
          for (const invoiceColumn of ['xero_invoice_id', 'accounting_invoice_id']) {
            try {
              const { error: tfpErr } = await supabase
                .from('training_fund_purchase')
                .update({ purchase_order_number: poNumber.trim(), po_to_follow: false })
                .eq('tenant_id', feeToken.tenant_id)
                .eq(invoiceColumn, invoiceId)
                .eq('payment_method', 'invoice');
              if (tfpErr) {
                console.warn(`[Public Fee] Failed to apply PO to linked training fund purchases (${invoiceColumn}):`, tfpErr.message || tfpErr);
              }
            } catch (tfpErr) {
              console.warn(`[Public Fee] Failed to apply PO to linked training fund purchases (${invoiceColumn}):`, tfpErr?.message || tfpErr);
            }
          }
        }

        try {
          const poNoteContent = `[Membership Fee - PO Submitted] Purchase order ${poNumber.trim()} submitted via fee link for ${feeToken.membership_year}.${feeToken.xero_invoice_number ? ` Xero invoice: ${feeToken.xero_invoice_number}.` : ''}`;
          if (isMemberToken) {
            await supabase.from('member_note').insert({
              member_id: feeToken.member_id,
              created_by: null,
              content: poNoteContent,
            });
          } else {
            await supabase.from('organization_note').insert({
              organization_id: feeToken.organization_id,
              member_id: null,
              content: poNoteContent,
              attachments: [],
            });
          }
        } catch {}

        const response = {
          success: true,
          message: 'Purchase order number submitted successfully',
          xeroInvoiceNumber: feeToken.xero_invoice_number || null,
          xeroOnlineInvoiceUrl: feeToken.xero_online_invoice_url || null,
        };
        if (poSyncWarning) response.warning = poSyncWarning;
        if (xeroPoWarning) response.xeroWarning = xeroPoWarning;
        return res.json(response);
      }

      if (action === 'create_payment') {
        if (await checkApprovalBlocked()) {
          return res.status(400).json({ error: 'Fees have not yet been approved for payment. Please contact your administrator.' });
        }

        // Double-payment guard (provider-independent): an open monthly plan
        // agreement (card OR Direct Debit) for this membership year blocks
        // the one-off annual PaymentIntent, or the member could pay annually
        // while the plan keeps charging monthly.
        if (isMemberToken) {
          const { annualPaymentBlockedByOpenPlan } = await import('../../membership/monthly-card.js');
          const blocked = await annualPaymentBlockedByOpenPlan({
            tenantId: feeToken.tenant_id,
            memberId: feeToken.member_id,
            yearLabel: feeToken.membership_year,
          });
          if (blocked) {
            return res.status(409).json({
              error: 'A monthly payment plan already exists for this membership year. Please continue with the plan, or contact your administrator to cancel it before paying annually.',
              code: 'open_plan_exists',
              provider: blocked.provider,
            });
          }
        }

        const { getStripeCredentials, findOrCreateStripeCustomer } = await import('../../_lib/stripeCredentials.js');
        const Stripe = (await import('stripe')).default;

        const stripeCredentials = await getStripeCredentials(feeToken.tenant_id, 'membership');
        if (!stripeCredentials?.secret_key) {
          return res.status(503).json({ error: 'Payment processing is not available' });
        }

        const stripe = new Stripe(stripeCredentials.secret_key);
        const tokenBreakdown = feeToken.cost_breakdown || {};
        const chargeTotal = tokenBreakdown.totalWithVat || parseFloat(feeToken.final_cost);
        const amount = Math.round(chargeTotal * 100);
        const STRIPE_MIN_CENTS = { gbp: 30, usd: 50, eur: 50, aud: 50, nzd: 50 };
        const cur = (feeToken.currency || 'GBP').toLowerCase();
        const minCents = STRIPE_MIN_CENTS[cur] || 50;
        if (amount < minCents) {
          return res.status(400).json({ error: `Amount is below the minimum charge for ${cur.toUpperCase()}` });
        }

        let payerName = memberDisplayName;
        if (!isMemberToken) {
          const { data: org } = await supabase
            .from('organization')
            .select('name')
            .eq('id', feeToken.organization_id)
            .single();
          payerName = org?.name || 'Organisation';
        }

        const stripeCustomer = feeToken.recipient_email
          ? await findOrCreateStripeCustomer(stripe, {
              email: feeToken.recipient_email,
              name: payerName || undefined,
              metadata: isMemberToken
                ? { tenant_id: feeToken.tenant_id, member_id: feeToken.member_id, member_name: payerName || '' }
                : { tenant_id: feeToken.tenant_id, organization_id: feeToken.organization_id, organization_name: payerName || '' },
            })
          : null;

        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: (feeToken.currency || 'GBP').toLowerCase(),
          customer: stripeCustomer?.id || undefined,
          receipt_email: feeToken.recipient_email || undefined,
          metadata: {
            token_id: feeToken.id,
            ...(isMemberToken
              ? { member_id: feeToken.member_id }
              : { organization_id: feeToken.organization_id }),
            membership_year: feeToken.membership_year,
            tenant_id: feeToken.tenant_id,
          },
          description: `Membership fee for ${payerName || 'Member'} - ${feeToken.membership_year}`,
        });

        await supabase
          .from('membership_fee_token')
          .update({
            stripe_payment_intent_id: paymentIntent.id,
            stripe_client_secret: paymentIntent.client_secret,
            updated_at: new Date().toISOString(),
          })
          .eq('id', feeToken.id);

        return res.json({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        });
      }

      if (action === 'confirm_payment') {
        // -----------------------------------------------------------------
        // Task #1112 — Hardened confirm_payment flow.
        //
        // Failure-mode policy (documented per task spec): on any error
        // between Stripe capture and history-row insert, the system AUTO-
        // REFUNDS the Stripe payment and resets the fee token so the user
        // can retry from scratch. We deliberately do NOT leave a paid
        // token without a backing history row.
        //
        // Sequencing (was: token→paid, then sim, then insert):
        //   1. Verify Stripe PI succeeded + amount matches.
        //   2. Stamp the PI onto the token (status still pending) so a
        //      refund/cron can recover even if this process dies mid-flow.
        //   3. Run the simulator. If success=false → log full error+steps
        //      at error level, auto-refund, clear PI, return 500.
        //   4. Insert the history row.
        //   5. Only NOW flip the token to status='paid'.
        //   6. Attempt to create/apply the accounting invoice. Failures
        //      here are NOT silently swallowed — the history row is
        //      flagged with accounting_sync_status='failed' +
        //      accounting_sync_error and the API response carries a
        //      warning so the admin UI can show a retry affordance.
        //
        // Idempotency (was: only checked history_history.stripe_payment_intent_id):
        //   The new probe consults BOTH the history table AND the fee
        //   token. A stuck-paid token (status='paid', PI set, no history
        //   row) returns 409 with a recovery hint instead of silently
        //   re-running the entire flow.
        // -----------------------------------------------------------------

        const { paymentIntentId } = req.body;
        if (!paymentIntentId) {
          return res.status(400).json({ error: 'paymentIntentId is required' });
        }

        const historyTable = isMemberToken ? 'member_membership_history' : 'organisation_membership_history';
        const noteTable = isMemberToken ? 'member_note' : 'organization_note';

        // Idempotency probe — by history row first (the original path).
        const { data: existingByPI } = await supabase
          .from(historyTable)
          .select('id')
          .eq('stripe_payment_intent_id', paymentIntentId)
          .maybeSingle();

        if (existingByPI) {
          console.log(`[Public Fee] Idempotent return: history row already exists for PI ${paymentIntentId}`);
          if (feeToken.status !== 'paid') {
            await supabase.from('membership_fee_token').update({ status: 'paid', paid_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', feeToken.id);
          }
          return res.json({ success: true, already_processed: true, recordCreated: true, message: 'Payment already confirmed' });
        }

        // Idempotency probe — token already paid with this PI but no
        // history row. This is the stuck-token state. Surface it loudly
        // instead of silently re-driving Stripe verification + simulator
        // on every retry.
        if (feeToken.status === 'paid' && feeToken.stripe_payment_intent_id === paymentIntentId) {
          console.error(`[Public Fee] STUCK TOKEN: token ${feeToken.id} is paid with PI ${paymentIntentId} but no history row exists. Manual recovery required (admin can run scripts/backfill-stuck-membership-fee-tokens.mjs).`);
          return res.status(409).json({
            error: 'This payment was received but the membership record was not created. The administrator has been notified and will resolve this within one business day; please do not retry.',
            stuckTokenId: feeToken.id,
          });
        }

        if (await checkApprovalBlocked()) {
          return res.status(400).json({ error: 'Fees have not yet been approved for payment. Please contact your administrator.' });
        }

        const { retrieveTenantPaymentIntent } = await import('../../_lib/stripeCredentials.js');

        // Task #3278 — mode-flip resilient PI lookup. If the tenant's
        // stripe_mode_membership flipped mid-session (the live incident on
        // 2026-07-31), the PI lives in the other mode's Stripe account;
        // retrieve it there rather than failing resource_missing after the
        // card was charged.
        let retrieved;
        try {
          retrieved = await retrieveTenantPaymentIntent(feeToken.tenant_id, 'membership', paymentIntentId);
        } catch (retrieveErr) {
          console.error(`[MEMBERSHIP-CONFIRM-FAILURE] [Public Fee] Could not retrieve PI ${paymentIntentId} in either Stripe mode (tenant ${feeToken.tenant_id}, token ${feeToken.id}): ${retrieveErr.message}`);
          return res.status(500).json({ error: 'We could not verify your payment with Stripe. If your card was charged (you received a Stripe receipt), your membership will be reconciled automatically — please do not pay again. Otherwise, please retry.' });
        }
        if (!retrieved) {
          return res.status(503).json({ error: 'Payment verification not available' });
        }
        const { paymentIntent, stripe } = retrieved;

        if (paymentIntent.status !== 'succeeded') {
          return res.status(400).json({ error: 'Payment has not been completed', status: paymentIntent.status });
        }

        // From here on the charge HAS succeeded — rejections must be logged
        // distinctly and must tell the payer the money was taken and will be
        // reconciled (Task #3278), never imply the payment failed.
        const confirmFailure = (reason, extra = {}) => {
          console.error(`[MEMBERSHIP-CONFIRM-FAILURE] [Public Fee] Succeeded PI ${paymentIntentId} could not be recorded: ${reason}`, JSON.stringify({ tenantId: feeToken.tenant_id, tokenId: feeToken.id, memberId: feeToken.member_id || null, organizationId: feeToken.organization_id || null, ...extra }));
          return res.status(400).json({
            error: 'Your card payment was successful and you will receive a Stripe receipt, but we could not finish updating your membership record automatically. It will be reconciled by the administrator shortly — please do NOT pay again.',
            paymentSucceeded: true,
            reason,
          });
        };

        // Task #3278 — a re-initialised fee page stamps a NEWER PI onto the
        // token; a payer completing the OLDER (or a concurrent) PI must not
        // be rejected after their card was charged. Trust the PI's own
        // metadata binding instead of the last-stamped id.
        if (paymentIntent.metadata?.token_id !== feeToken.id) {
          return confirmFailure('PI metadata token_id does not match this fee token', { piTokenId: paymentIntent.metadata?.token_id, stampedPI: feeToken.stripe_payment_intent_id });
        }

        const confirmBreakdown = feeToken.cost_breakdown || {};
        const confirmTotal = confirmBreakdown.totalWithVat || parseFloat(feeToken.final_cost);
        const expectedAmount = Math.round(confirmTotal * 100);
        if (paymentIntent.amount !== expectedAmount) {
          return confirmFailure(`amount mismatch: expected ${expectedAmount}, PI charged ${paymentIntent.amount}`);
        }

        // Task #1112 — stamp the PI on the token (status still pending) so
        // any subsequent failure path can locate this payment for refund/
        // recovery. DO NOT flip status to 'paid' yet — that only happens
        // after the history row has been successfully inserted below.
        await supabase
          .from('membership_fee_token')
          .update({
            stripe_payment_intent_id: paymentIntentId,
            updated_at: new Date().toISOString(),
          })
          .eq('id', feeToken.id);

        const { simulateMembershipForOrg, simulateMembershipForMember } = await import('../../_lib/membershipSimulation.js');
        const simResult = isMemberToken
          ? await simulateMembershipForMember(feeToken.tenant_id, feeToken.member_id, {
              source: 'stripe-payment',
              mode: 'manual',
              targetYear: feeToken.membership_year,
            })
          : await simulateMembershipForOrg(feeToken.tenant_id, feeToken.organization_id, {
              source: 'stripe-payment',
              mode: 'manual',
              targetYear: feeToken.membership_year,
            });

        // Task #1112 — explicit handling of simResult.success === false.
        // Previously this dropped through to the (recordCreated=false)
        // branch which returned success:true with no history row + no
        // invoice — silent loss. We now auto-refund (consistent with the
        // history-insert failure path further down) and surface a 500.
        if (!simResult.success) {
          // Task #3278 — no auto-refund: the charge succeeded, and the
          // Stripe membership webhook / reconcile cron will record the
          // payment from the token snapshot. Refunding here would race
          // the webhook and could produce a refunded-but-paid membership.
          // Keep the PI stamped on the token so reconciliation can find it.
          return confirmFailure(`simulation failed during confirm: ${simResult.error || 'unknown'}`, { simSteps: simResult.steps });
        }

        let recordCreated = false;
        let historyRecord = null;
        if (simResult.success && simResult.existingRecord) {
          // Cron-created path (Task #990): a history record already exists
          // (created by the auto-renewal cron). Load it and stamp the Stripe
          // PI for traceability so confirm-payment is idempotent against
          // existing-record tokens too.
          try {
            const { data: existing } = await supabase
              .from(historyTable)
              .select('*')
              .eq('id', feeToken.history_record_id || '00000000-0000-0000-0000-000000000000')
              .maybeSingle();
            historyRecord = existing
              || (await supabase
                .from(historyTable)
                .select('*')
                .eq('tenant_id', feeToken.tenant_id)
                .eq(isMemberToken ? 'member_id' : 'organization_id', isMemberToken ? feeToken.member_id : feeToken.organization_id)
                .eq('membership_year', feeToken.membership_year)
                .maybeSingle()).data;
            if (historyRecord && !historyRecord.stripe_payment_intent_id) {
              await supabase
                .from(historyTable)
                .update({ payment_method: 'stripe', stripe_payment_intent_id: paymentIntentId })
                .eq('id', historyRecord.id);
            }
            recordCreated = !!historyRecord;
          } catch (linkErr) {
            console.warn('[Public Fee] Could not link existing history record:', linkErr.message);
          }
        }
        if (simResult.success && !simResult.existingRecord) {
          // If the token snapshot includes add-on lines, its final_cost /
          // totals are addon-inclusive — store the record with the token's
          // totals and the "add-on line(s) included." marker so any later
          // invoicing path knows not to add them again.
          const cbForRecord = feeToken.cost_breakdown || {};
          const tokenAddons = Array.isArray(cbForRecord.addonLines) ? cbForRecord.addonLines : [];
          const { data: insertedRecord, error: insertError } = await supabase
            .from(historyTable)
            .insert({
              tenant_id: feeToken.tenant_id,
              ...(isMemberToken
                ? { member_id: feeToken.member_id }
                : { organization_id: feeToken.organization_id }),
              membership_year: simResult.membershipYear.label,
              config_id: simResult.config?.id || null,
              band_id: simResult.matchedBand?.id || null,
              tier_label: simResult.tierLabel,
              field_value: simResult.fieldValue,
              annual_cost: simResult.annualCost,
              prorata_cost: simResult.prorataCost,
              free_period_discount: simResult.freeDiscount || 0,
              rollover_discount: simResult.rolloverDiscount || 0,
              custom_discount_total: simResult.customDiscountTotal || 0,
              custom_discount_details: simResult.customDiscountDetails?.length > 0 ? simResult.customDiscountDetails : null,
              final_cost: parseFloat(feeToken.final_cost),
              currency: feeToken.currency || 'GBP',
              billing_period: simResult.billingPeriod || 'annual',
              purchase_order_number: feeToken.po_number || null,
              vat_rate_percent: simResult.vatRatePercent || null,
              vat_amount: tokenAddons.length > 0
                ? (cbForRecord.vatAmount || 0)
                : (simResult.vatAmount || 0),
              total_with_vat: tokenAddons.length > 0
                ? (cbForRecord.totalWithVat || parseFloat(feeToken.final_cost))
                : (simResult.totalWithVat || parseFloat(feeToken.final_cost)),
              year_number: simResult.yearNumber || null,
              prorata_days: simResult.prorataDays || null,
              free_period_days_applied: simResult.freePeriodDaysApplied || 0,
              override_applied: simResult.overrideApplied || false,
              override_type: simResult.overrideType || null,
              payment_method: 'stripe',
              stripe_payment_intent_id: paymentIntentId,
              status: 'active',
              notes: `Payment received via Stripe (${paymentIntentId}). Fee link: ${token.substring(0, 8)}...${tokenAddons.length > 0 ? ` ${tokenAddons.length} add-on line(s) included.` : ''}`,
            })
            .select()
            .single();

          if (!insertError) {
            recordCreated = true;
            historyRecord = insertedRecord;
          } else if (insertError.code === '23505') {
            console.log(`[Public Fee] Duplicate constraint hit for PI ${paymentIntentId} - already processed`);
            recordCreated = true;
          } else {
            // Task #3278 — no auto-refund: the charge succeeded and the
            // Stripe membership webhook / reconcile cron will record it
            // (reconstructing the row from the token if needed). Refunding
            // would race the webhook and could produce a refunded-but-paid
            // membership. Keep the PI stamped on the token for recovery.
            console.error(`[MEMBERSHIP-CONFIRM-FAILURE] [Public Fee] History insert failed after succeeded PI ${paymentIntentId}: ${insertError.message}`, JSON.stringify({ tenantId: feeToken.tenant_id, tokenId: feeToken.id, code: insertError.code }));
            return res.status(500).json({
              error: 'Your card payment was successful and you will receive a Stripe receipt, but we could not finish updating your membership record automatically. It will be reconciled by the administrator shortly — please do NOT pay again.',
              paymentSucceeded: true,
            });
          }
        }

        // Task #1112 — history row is now safely persisted (or already
        // existed). NOW we can flip the token to 'paid'. Doing this
        // earlier would have left the token in a misleading state if any
        // of the steps above failed.
        if (recordCreated && feeToken.status !== 'paid') {
          await supabase
            .from('membership_fee_token')
            .update({
              status: 'paid',
              paid_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', feeToken.id);
        }

        let xeroInvoice = null;
        let accountingSyncError = null;
        if (recordCreated) {
          try {
            if (feeToken.xero_invoice_id) {
              // Cron-created invoice already exists (Task #990). Apply the
              // Stripe payment to it instead of minting a duplicate. Route
              // through the provider facade so the same flow works for both
              // Xero and QuickBooks (the column is named xero_invoice_id for
              // legacy reasons, but holds whichever provider's invoice id
              // was minted by the cron).
              const { getAccountingProvider, buildInvoiceColumnUpdate } = await import('../../_lib/accountingProvider.js');
              const provider = await getAccountingProvider(feeToken.tenant_id);
              xeroInvoice = await provider.applyStripePaymentToInvoice({
                appTenantId: feeToken.tenant_id,
                invoiceId: feeToken.xero_invoice_id,
                xeroInvoiceId: feeToken.xero_invoice_id,
                stripePaymentIntentId: paymentIntentId,
              });
              if (xeroInvoice?.online_invoice_url) {
                try {
                  await supabase
                    .from('membership_fee_token')
                    .update({ xero_online_invoice_url: xeroInvoice.online_invoice_url, updated_at: new Date().toISOString() })
                    .eq('id', feeToken.id);
                } catch {}
              }
              if (historyRecord && !historyRecord.xero_invoice_id && !historyRecord.accounting_invoice_id) {
                try {
                  await supabase
                    .from(historyTable)
                    .update(buildInvoiceColumnUpdate({
                      invoice_id: feeToken.xero_invoice_id,
                      invoice_number: feeToken.xero_invoice_number,
                      provider: provider.name,
                    }))
                    .eq('id', historyRecord.id);
                } catch {}
              }
            } else {
              const { getAccountingProvider, buildInvoiceColumnUpdate } = await import('../../_lib/accountingProvider.js');
              let invoicingName;
              let invoicingEmail;
              let invoicingAddress;
              if (isMemberToken) {
                const { resolveInvoiceAddress } = await import('../../_lib/invoiceAddressResolver.js');
                invoicingName = memberDisplayName || 'Member';
                invoicingEmail = tokenMember?.email || null;
                invoicingAddress = await resolveInvoiceAddress(supabase, simResult.config, feeToken.member_id, 'member');
              } else {
                const { data: org } = await supabase
                  .from('organization')
                  .select('name, invoicing_address, invoicing_email')
                  .eq('id', feeToken.organization_id)
                  .single();
                invoicingName = org?.name || 'Organisation';
                invoicingEmail = org?.invoicing_email || null;
                invoicingAddress = org?.invoicing_address;
              }

              const reference = feeToken.po_number
                ? `Membership ${feeToken.membership_year} - PO: ${feeToken.po_number}`
                : `Membership ${feeToken.membership_year}`;

              // If the token's totals include add-on lines, the invoice must
              // itemise them: membership fee line = final_cost minus the
              // add-on subtotal, add-ons as their own extra line items.
              let invoiceAddonLines = [];
              let invoiceMembershipCost = parseFloat(feeToken.final_cost);
              if (!isMemberToken && Array.isArray(feeToken.cost_breakdown?.addonLines) && feeToken.cost_breakdown.addonLines.length > 0) {
                try {
                  const { loadAddonLines, computeAddonTotals } = await import('../../_lib/membershipAddons.js');
                  const storedAddons = await loadAddonLines(feeToken.tenant_id, feeToken.organization_id, feeToken.membership_year);
                  if (storedAddons.length > 0) {
                    const storedTotals = computeAddonTotals(storedAddons);
                    invoiceAddonLines = storedAddons;
                    invoiceMembershipCost = Math.max(0, Math.round((invoiceMembershipCost - storedTotals.subtotal) * 100) / 100);
                  }
                } catch {}
              }

              const _provider = await getAccountingProvider(feeToken.tenant_id);
              const { buildExtraLineItems: _buildExtra } = await import('../../_lib/membershipAddons.js');
              xeroInvoice = await _provider.createMembershipInvoice({
                appTenantId: feeToken.tenant_id,
                organizationName: invoicingName,
                invoicingEmail,
                invoicingAddress,
                membershipYear: feeToken.membership_year,
                tierLabel: feeToken.tier_label,
                finalCost: invoiceMembershipCost,
                currency: feeToken.currency || 'GBP',
                reference,
                vatRate: simResult.taxType || simResult.matchedBand?.vat_rate || null,
                nominalCode: await (await import('../../_lib/membershipNominalCode.js'))
                  .resolveMembershipNominalCode(supabase, feeToken.tenant_id, simResult),
                markAsPaid: true,
                stripePaymentIntentId: paymentIntentId,
                invoiceDescription: simResult.config?.invoice_description || null,
                extraLineItems: _buildExtra(invoiceAddonLines),
              });
              if (xeroInvoice && invoiceAddonLines.length > 0) {
                try {
                  const { processTrainingFundAddons } = await import('../../_lib/membershipAddons.js');
                  await processTrainingFundAddons({
                    tenantId: feeToken.tenant_id,
                    organizationId: feeToken.organization_id,
                    invoice: xeroInvoice,
                    addonLines: invoiceAddonLines,
                  });
                } catch (tfErr) {
                  console.error('[Public Fee] Training fund add-on processing failed (non-fatal):', tfErr.message);
                }
              }
              // Task #1017 — persist invoice id/number on the history row so
              // the inline reconciliation below (and the cron, if it falls
              // through) can locate it.
              if (xeroInvoice && historyRecord) {
                try {
                  await supabase
                    .from(historyTable)
                    .update(buildInvoiceColumnUpdate({
                      invoice_id: xeroInvoice.invoice_id,
                      invoice_number: xeroInvoice.invoice_number,
                      provider: _provider.name,
                    }))
                    .eq('id', historyRecord.id);
                } catch {}
              }
            }
          } catch (xeroErr) {
            // Task #1112 — was previously logged and silently swallowed.
            // The membership payment is captured AND the history row is
            // persisted; only the accounting-side invoice failed. Flag
            // the history row so the admin UI can show a warning + retry
            // button instead of pretending everything succeeded.
            console.error('[Public Fee] Accounting invoice failed for PI ' + paymentIntentId + ':', xeroErr);
            accountingSyncError = xeroErr?.message || String(xeroErr) || 'Unknown accounting provider error';
            if (historyRecord?.id) {
              try {
                await supabase
                  .from(historyTable)
                  .update({
                    accounting_sync_status: 'failed',
                    accounting_sync_error: accountingSyncError.slice(0, 1000),
                  })
                  .eq('id', historyRecord.id);
              } catch (flagErr) {
                console.error('[Public Fee] Failed to flag accounting_sync_status on history row:', flagErr.message);
              }
            }
          }

          // Task #1017 — fire workflow immediately for both the pre-created
          // invoice path AND the newly-created-on-confirm path. The helper
          // is idempotent and a no-op when the row is already in a terminal
          // payment state.
          if (xeroInvoice && historyRecord?.id) {
            try {
              const { reconcileMembershipInvoicePayment } = await import('../../_lib/membershipPaymentReconciliation.js');
              // Task #3253 — pass the request-derived base URL so the
              // membership-paid workflow can mint {{set_password_url}} links.
              const reconcileBaseUrl = req.headers.host
                ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
                : '';
              await reconcileMembershipInvoicePayment({
                table: historyTable,
                recordId: historyRecord.id,
                baseUrl: reconcileBaseUrl,
              });
            } catch (reconcileErr) {
              console.warn('[Public Fee] inline payment reconciliation failed (non-fatal):', reconcileErr.message);
            }
          }

          if (xeroInvoice && historyRecord && !isMemberToken) {
            try {
              const { sendMembershipInvoiceEmail } = await import('../../_lib/membershipInvoiceEmail.js');
              const { data: emailOrg } = await supabase
                .from('organization')
                .select('name')
                .eq('id', feeToken.organization_id)
                .single();

              const tokenBreakdownForEmail = feeToken.cost_breakdown || {};
              await sendMembershipInvoiceEmail({
                tenantId: feeToken.tenant_id,
                organizationId: feeToken.organization_id,
                organizationName: emailOrg?.name || 'Organisation',
                membershipYear: feeToken.membership_year,
                finalCost: parseFloat(feeToken.final_cost),
                currency: feeToken.currency || 'GBP',
                tierLabel: feeToken.tier_label,
                xeroInvoiceNumber: xeroInvoice.invoice_number,
                xeroInvoiceId: xeroInvoice.invoice_id,
                historyRecordId: historyRecord.id,
                vatAmount: tokenBreakdownForEmail.vatAmount || 0,
                totalWithVat: tokenBreakdownForEmail.totalWithVat || parseFloat(feeToken.final_cost),
                onlineInvoiceUrl: xeroInvoice.online_invoice_url || null,
                tierConfig: simResult?.config,
              });
            } catch (emailErr) {
              console.error('[Public Fee] Invoice email failed (non-fatal):', emailErr.message);
            }
          }
          // Member tokens: Stripe's receipt_email already covers the payment
          // receipt; the tenant invoice email templates/recipients are
          // organisation-shaped, so we skip the separate invoice email here.
        }

        try {
          const invoiceNote = xeroInvoice
            ? ` Xero invoice ${xeroInvoice.invoice_number} created.`
            : recordCreated ? ` Accounting invoice could not be created${accountingSyncError ? ` (${accountingSyncError})` : ''}; flagged for admin retry.` : '';
          const paymentNoteContent = `[Membership Fee - Stripe Payment] Payment received for ${feeToken.membership_year}. Amount: ${feeToken.currency} ${parseFloat(confirmTotal).toFixed(2)}${confirmBreakdown.vatAmount > 0 ? ` (incl. VAT ${parseFloat(confirmBreakdown.vatAmount).toFixed(2)})` : ''}. Stripe PI: ${paymentIntentId}.${invoiceNote}`;
          if (isMemberToken) {
            await supabase.from('member_note').insert({
              member_id: feeToken.member_id,
              created_by: null,
              content: paymentNoteContent,
            });
          } else {
            await supabase.from('organization_note').insert({
              organization_id: feeToken.organization_id,
              member_id: null,
              content: paymentNoteContent,
              attachments: [],
            });
          }
        } catch {}

        return res.json({
          success: true,
          recordCreated,
          xeroInvoice: xeroInvoice ? { invoice_number: xeroInvoice.invoice_number } : null,
          xeroInvoiceNumber: xeroInvoice?.invoice_number || feeToken.xero_invoice_number || null,
          xeroOnlineInvoiceUrl: xeroInvoice?.online_invoice_url || feeToken.xero_online_invoice_url || null,
          accountingSyncError: accountingSyncError || null,
          warning: accountingSyncError
            ? 'Your payment was received and your membership is recorded, but the accounting invoice could not be generated automatically. The administrator has been notified and will issue it manually.'
            : null,
          message: 'Payment confirmed successfully',
        });
      }

      // Task #3211 — start GoCardless Direct Debit set-up from the public
      // fee page. Authorised by possession of the fee token (member tokens
      // only). Mirrors POST /api/membership/direct-debit action=start, with
      // one difference: a workflow-recorded (unpaid, non-DD) history row for
      // the year is ADOPTED (linked to the agreement and switched to
      // direct_debit) rather than refused.
      if (action === 'start_direct_debit') {
        if (!isMemberToken || !tokenMember) {
          return res.status(400).json({ error: 'Direct Debit is only available for individual memberships' });
        }

        if (await checkApprovalBlocked()) {
          return res.status(403).json({ error: 'Your membership fees are awaiting approval. Please try again once they have been approved.' });
        }

        const { getGocardlessCredentials } = await import('../../_lib/gocardlessCredentials.js');
        const creds = await getGocardlessCredentials(feeToken.tenant_id);
        if (!creds?.accessToken) {
          return res.status(400).json({ error: 'Direct Debit is not available for this organisation' });
        }

        const { simulateMembershipForMember } = await import('../../_lib/membershipSimulation.js');
        const simResult = await simulateMembershipForMember(feeToken.tenant_id, feeToken.member_id, {
          source: 'fee-token-dd',
          mode: 'manual',
          targetYear: feeToken.membership_year,
        });
        if (!simResult.success) {
          return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
        }
        const { resolveDdOffer, buildAgreementSnapshot, findReusableMandate, ensureSubscriptionForAgreement, activateMembershipForAgreement } = await import('../../_lib/gocardlessDirectDebit.js');
        const offer = resolveDdOffer(simResult);
        if (!offer) {
          return res.status(400).json({ error: 'Monthly Direct Debit is not available for this membership' });
        }

        const yearLabel = simResult.membershipYear?.label || feeToken.membership_year;

        const { data: existingHistory } = await supabase
          .from('member_membership_history')
          .select('id, status, payment_status, payment_method, billing_agreement_id, stripe_payment_intent_id')
          .eq('tenant_id', feeToken.tenant_id)
          .eq('member_id', feeToken.member_id)
          .eq('membership_year', yearLabel)
          .maybeSingle();
        if (existingHistory && (existingHistory.payment_status === 'paid' || existingHistory.stripe_payment_intent_id)) {
          return res.status(400).json({ error: 'Membership for this year has already been paid' });
        }

        // Double-payment guard (Task #3620): an open monthly-card plan for
        // this year blocks starting a Direct Debit plan.
        {
          const { findOpenAgreementForYear } = await import('../../membership/monthly-card.js');
          const openOther = await findOpenAgreementForYear({ tenantId: feeToken.tenant_id, memberId: feeToken.member_id, yearLabel });
          if (openOther && openOther.provider === 'stripe') {
            return res.status(400).json({ error: 'A monthly card payment plan is already set up for this membership year' });
          }
        }

        const { gocardlessForTenant, buildIdempotencyKey } = await import('../../_lib/gocardless.js');
        const { STATUS } = await import('../../_lib/gocardlessState.js');
        const { sendDdLifecycleEmail } = await import('../../_lib/gocardlessDdEmails.js');
        const { markRenewalConfirmed } = await import('../../_lib/gocardlessDdRenewals.js');

        const idempotencyKey = buildIdempotencyKey('dd-agree', feeToken.tenant_id, feeToken.member_id, yearLabel);

        // Idempotent re-entry: reuse the in-flight agreement + hosted flow URL.
        const { data: existingAgreement } = await supabase
          .from('membership_billing_agreements')
          .select('*')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (existingAgreement) {
          if (existingAgreement.status === STATUS.PAYMENT_SETUP_REQUIRED && existingAgreement.redirect_url) {
            return res.json({ authorisationUrl: existingAgreement.redirect_url, flowId: existingAgreement.gocardless_billing_request_flow_id || null, environment: existingAgreement.environment || 'sandbox', agreementId: existingAgreement.id, resumed: true });
          }
          return res.json({ agreementId: existingAgreement.id, status: existingAgreement.status, resumed: true });
        }

        const snapshot = buildAgreementSnapshot({ offer, simResult });
        const gcClient = await gocardlessForTenant(feeToken.tenant_id);
        const reusable = await findReusableMandate({ tenantId: feeToken.tenant_id, memberId: feeToken.member_id });

        const agreementInsert = {
          tenant_id: feeToken.tenant_id,
          member_id: feeToken.member_id,
          agreement_type: 'member',
          status: STATUS.PAYMENT_SETUP_REQUIRED,
          idempotency_key: idempotencyKey,
          environment: creds.environment || 'sandbox',
          metadata: { dd: snapshot },
        };

        let authorisationUrl = null;
        if (reusable) {
          agreementInsert.gocardless_mandate_id = reusable.mandateId;
          agreementInsert.gocardless_customer_id = reusable.customerId;
          agreementInsert.status = STATUS.MANDATE_PENDING;
        } else {
          const billingRequest = await gcClient.createBillingRequest({
            idempotencyKey: buildIdempotencyKey('dd-br', feeToken.tenant_id, feeToken.member_id, yearLabel),
            currency: offer.currency,
            metadata: { tenant_id: feeToken.tenant_id, member_id: feeToken.member_id, membership_year: yearLabel, kind: 'monthly_direct_debit' },
          });
          const proto = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers['x-forwarded-host'] || req.headers.host;
          const origin = host ? `${proto}://${host}` : null;
          const flow = await gcClient.createBillingRequestFlow({
            billingRequestId: billingRequest.id,
            redirectUri: origin ? `${origin}/membership-fees/${token}?dd=complete` : undefined,
            exitUri: origin ? `${origin}/membership-fees/${token}?dd=cancelled` : undefined,
            idempotencyKey: buildIdempotencyKey('dd-brf', feeToken.tenant_id, feeToken.member_id, yearLabel),
            prefilledCustomer: {
              email: tokenMember.email || undefined,
              given_name: tokenMember.first_name || undefined,
              family_name: tokenMember.last_name || undefined,
            },
          });
          agreementInsert.gocardless_billing_request_id = billingRequest.id;
          agreementInsert.gocardless_billing_request_flow_id = flow.id;
          agreementInsert.redirect_url = flow.authorisation_url;
          authorisationUrl = flow.authorisation_url;
        }

        const { data: agreement, error: agreeErr } = await supabase
          .from('membership_billing_agreements')
          .insert(agreementInsert)
          .select()
          .single();
        if (agreeErr) {
          if (agreeErr.code === '23505') {
            const { data: raced } = await supabase
              .from('membership_billing_agreements')
              .select('*')
              .eq('idempotency_key', idempotencyKey)
              .maybeSingle();
            if (raced?.redirect_url) return res.json({ authorisationUrl: raced.redirect_url, flowId: raced.gocardless_billing_request_flow_id || null, environment: raced.environment || 'sandbox', agreementId: raced.id, resumed: true });
            if (raced) return res.json({ agreementId: raced.id, status: raced.status, resumed: true });
          }
          console.error('[Public Fee] Failed to create DD agreement:', agreeErr);
          return res.status(500).json({ error: 'Failed to start Direct Debit set-up' });
        }

        if (!existingHistory) {
          const { error: histErr } = await supabase.from('member_membership_history').insert({
            tenant_id: feeToken.tenant_id,
            member_id: feeToken.member_id,
            membership_year: yearLabel,
            config_id: simResult.config?.id || null,
            band_id: simResult.matchedBand?.id || null,
            tier_label: simResult.tierLabel,
            field_value: simResult.fieldValue,
            annual_cost: simResult.annualCost,
            final_cost: snapshot.plan_total,
            currency: offer.currency,
            billing_period: 'monthly_direct_debit',
            vat_rate_percent: simResult.vatRatePercent || null,
            vat_amount: simResult.vatAmount || 0,
            total_with_vat: snapshot.plan_total,
            payment_method: 'direct_debit',
            status: 'pending_payment_setup',
            payment_status: 'unpaid',
            billing_agreement_id: agreement.id,
            notes: `Monthly Direct Debit: ${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}`,
          });
          if (histErr) {
            console.error('[Public Fee] Failed to create DD membership history row:', histErr);
            return res.status(500).json({ error: 'Failed to record membership' });
          }
        } else {
          // Adopt the workflow-recorded fee row: link the agreement and
          // switch its payment method so DD activation/webhooks find it via
          // billing_agreement_id. The already-raised accounting invoice (if
          // any) stays attached; a note records the switch for finance.
          const { error: linkErr } = await supabase
            .from('member_membership_history')
            .update({
              billing_agreement_id: agreement.id,
              payment_method: 'direct_debit',
              billing_period: 'monthly_direct_debit',
            })
            .eq('id', existingHistory.id);
          if (linkErr) {
            console.error('[Public Fee] Failed to link DD agreement onto existing history row:', linkErr);
            return res.status(500).json({ error: 'Failed to record membership' });
          }
          try {
            await supabase.from('member_note').insert({
              member_id: feeToken.member_id,
              created_by: null,
              content: `[Membership Fee - Direct Debit] Member started monthly Direct Debit set-up via fee link for ${yearLabel} (${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}).${feeToken.xero_invoice_number ? ` Existing invoice ${feeToken.xero_invoice_number} remains attached.` : ''}`,
            });
          } catch {}
        }

        await sendDdLifecycleEmail('setup_started', agreement, { db: supabase });
        await markRenewalConfirmed({ tenantId: feeToken.tenant_id, memberId: feeToken.member_id, yearLabel, newAgreementId: agreement.id });

        if (reusable) {
          const subResult = await ensureSubscriptionForAgreement(agreement, {});
          const actResult = await activateMembershipForAgreement(agreement, { trigger: 'mandate_active' });
          await sendDdLifecycleEmail('mandate_active', agreement, {
            db: supabase,
            extraContext: { firstChargeDate: subResult.plan?.next_charge_date || subResult.plan?.start_date || null },
          });
          return res.json({
            agreementId: agreement.id,
            reusedMandate: true,
            subscriptionCreated: subResult.created,
            activation: actResult.detail,
          });
        }

        return res.json({ authorisationUrl, flowId: agreement.gocardless_billing_request_flow_id || null, environment: agreement.environment || 'sandbox', agreementId: agreement.id });
      }

      // Task #3620 — start a monthly-card (Stripe subscription) plan from the
      // public fee page. Authorised by possession of the fee token (member
      // tokens only). Mirrors start_direct_debit, including adopting a
      // workflow-recorded unpaid history row.
      if (action === 'start_monthly_card') {
        if (!isMemberToken || !tokenMember) {
          return res.status(400).json({ error: 'Monthly card payment is only available for individual memberships' });
        }
        if (await checkApprovalBlocked()) {
          return res.status(403).json({ error: 'Your membership fees are awaiting approval. Please try again once they have been approved.' });
        }

        const { getStripeCredentials, findOrCreateStripeCustomer } = await import('../../_lib/stripeCredentials.js');
        const stripeCredentials = await getStripeCredentials(feeToken.tenant_id, 'membership');
        if (!stripeCredentials?.secret_key) {
          return res.status(400).json({ error: 'Card payment is not available for this organisation' });
        }

        const { simulateMembershipForMember } = await import('../../_lib/membershipSimulation.js');
        const simResult = await simulateMembershipForMember(feeToken.tenant_id, feeToken.member_id, {
          source: 'fee-token-card-monthly',
          mode: 'manual',
          targetYear: feeToken.membership_year,
        });
        if (!simResult.success) {
          return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
        }
        const { resolveCardMonthlyOffer, buildCardAgreementSnapshot, CARD_PLAN_KIND } = await import('../../_lib/stripeMonthlyCard.js');
        const offer = resolveCardMonthlyOffer(simResult);
        if (!offer) {
          return res.status(400).json({ error: 'Monthly card payment is not available for this membership' });
        }

        const yearLabel = simResult.membershipYear?.label || feeToken.membership_year;

        const { data: existingHistory } = await supabase
          .from('member_membership_history')
          .select('id, status, payment_status, payment_method, billing_agreement_id, stripe_payment_intent_id')
          .eq('tenant_id', feeToken.tenant_id)
          .eq('member_id', feeToken.member_id)
          .eq('membership_year', yearLabel)
          .maybeSingle();
        if (existingHistory && (existingHistory.payment_status === 'paid' || existingHistory.stripe_payment_intent_id)) {
          return res.status(400).json({ error: 'Membership for this year has already been paid' });
        }

        // Double-payment guard: an open DD agreement for this year blocks card.
        {
          const { findOpenAgreementForYear } = await import('../../membership/monthly-card.js');
          const openOther = await findOpenAgreementForYear({ tenantId: feeToken.tenant_id, memberId: feeToken.member_id, yearLabel });
          if (openOther && openOther.provider !== 'stripe') {
            return res.status(400).json({ error: 'A monthly Direct Debit plan is already set up for this membership year' });
          }
        }

        const { STATUS } = await import('../../_lib/gocardlessState.js');
        const idempotencyKey = `card-agree:${feeToken.tenant_id}:${feeToken.member_id}:${yearLabel}`;

        const { data: existingAgreement } = await supabase
          .from('membership_billing_agreements')
          .select('*')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (existingAgreement) {
          if (existingAgreement.status === STATUS.PAYMENT_SETUP_REQUIRED && existingAgreement.redirect_url) {
            return res.json({ checkoutUrl: existingAgreement.redirect_url, agreementId: existingAgreement.id, resumed: true });
          }
          return res.json({ agreementId: existingAgreement.id, status: existingAgreement.status, resumed: true });
        }

        const snapshot = buildCardAgreementSnapshot({ offer, simResult });
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(stripeCredentials.secret_key);
        const environment = stripeCredentials.secret_key.startsWith('sk_test_') ? 'test' : 'live';

        const customer = await findOrCreateStripeCustomer(stripe, {
          email: tokenMember.email,
          name: [tokenMember.first_name, tokenMember.last_name].filter(Boolean).join(' ') || undefined,
          metadata: { tenant_id: feeToken.tenant_id, member_id: feeToken.member_id },
        });

        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const origin = host ? `${proto}://${host}` : '';

        let session;
        try {
          session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customer?.id || undefined,
            customer_email: customer ? undefined : (tokenMember.email || undefined),
            line_items: [{
              quantity: 1,
              price_data: {
                currency: (offer.currency || 'GBP').toLowerCase(),
                unit_amount: offer.monthlyAmountMinor,
                recurring: { interval: 'month' },
                product_data: {
                  name: `Membership ${yearLabel || ''}`.trim(),
                  description: `${offer.instalmentCount} monthly instalments of ${offer.currency} ${offer.monthlyAmount.toFixed(2)} (total ${offer.currency} ${offer.planTotal.toFixed(2)})`,
                },
              },
            }],
            metadata: { kind: CARD_PLAN_KIND, tenant_id: feeToken.tenant_id, member_id: feeToken.member_id, membership_year: yearLabel || '' },
            subscription_data: {
              // Stripe-side finite-billing boundary (see api/membership/monthly-card.js):
              // 15 days past the final (Nth) monthly invoice, safely before an N+1th.
              cancel_at: (() => {
                const d = new Date();
                d.setUTCMonth(d.getUTCMonth() + (offer.instalmentCount - 1));
                d.setUTCDate(d.getUTCDate() + 15);
                return Math.floor(d.getTime() / 1000);
              })(),
              metadata: { kind: CARD_PLAN_KIND, tenant_id: feeToken.tenant_id, member_id: feeToken.member_id, membership_year: yearLabel || '' },
            },
            success_url: `${origin}/membership-fees/${token}?card=success`,
            cancel_url: `${origin}/membership-fees/${token}?card=cancelled`,
          });
        } catch (err) {
          console.error('[Public Fee] Card checkout session creation failed:', err.message);
          return res.status(502).json({ error: 'Could not start card checkout. Please try again.' });
        }

        const { data: agreement, error: agreeErr } = await supabase
          .from('membership_billing_agreements')
          .insert({
            tenant_id: feeToken.tenant_id,
            member_id: feeToken.member_id,
            agreement_type: 'member',
            provider: 'stripe',
            stripe_customer_id: customer?.id || null,
            stripe_checkout_session_id: session.id,
            status: STATUS.PAYMENT_SETUP_REQUIRED,
            idempotency_key: idempotencyKey,
            redirect_url: session.url,
            environment,
            metadata: { card: snapshot },
          })
          .select()
          .single();
        if (agreeErr) {
          if (agreeErr.code === '23505') {
            const { data: raced } = await supabase
              .from('membership_billing_agreements')
              .select('*')
              .eq('idempotency_key', idempotencyKey)
              .maybeSingle();
            if (raced?.redirect_url) return res.json({ checkoutUrl: raced.redirect_url, agreementId: raced.id, resumed: true });
            if (raced) return res.json({ agreementId: raced.id, status: raced.status, resumed: true });
          }
          console.error('[Public Fee] Failed to create card agreement:', agreeErr);
          try { await stripe.checkout.sessions.expire(session.id); } catch {}
          return res.status(500).json({ error: 'Failed to start card plan set-up' });
        }

        if (!existingHistory) {
          const { error: histErr } = await supabase.from('member_membership_history').insert({
            tenant_id: feeToken.tenant_id,
            member_id: feeToken.member_id,
            membership_year: yearLabel,
            config_id: simResult.config?.id || null,
            band_id: simResult.matchedBand?.id || null,
            tier_label: simResult.tierLabel,
            field_value: simResult.fieldValue,
            annual_cost: simResult.annualCost,
            final_cost: snapshot.plan_total,
            currency: offer.currency,
            billing_period: 'monthly_card',
            vat_rate_percent: simResult.vatRatePercent || null,
            vat_amount: simResult.vatAmount || 0,
            total_with_vat: snapshot.plan_total,
            payment_method: 'card_monthly',
            status: 'pending_payment_setup',
            payment_status: 'unpaid',
            billing_agreement_id: agreement.id,
            notes: `Monthly card plan: ${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}`,
          });
          if (histErr) {
            console.error('[Public Fee] Failed to create card membership history row:', histErr);
            return res.status(500).json({ error: 'Failed to record membership' });
          }
        } else {
          // Adopt the workflow-recorded fee row (parity with the DD path).
          const { error: linkErr } = await supabase
            .from('member_membership_history')
            .update({
              billing_agreement_id: agreement.id,
              payment_method: 'card_monthly',
              billing_period: 'monthly_card',
            })
            .eq('id', existingHistory.id);
          if (linkErr) {
            console.error('[Public Fee] Failed to link card agreement onto existing history row:', linkErr);
            return res.status(500).json({ error: 'Failed to record membership' });
          }
          try {
            await supabase.from('member_note').insert({
              member_id: feeToken.member_id,
              created_by: null,
              content: `[Membership Fee - Monthly Card] Member started monthly card plan set-up via fee link for ${yearLabel} (${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}).${feeToken.xero_invoice_number ? ` Existing invoice ${feeToken.xero_invoice_number} remains attached.` : ''}`,
            });
          } catch {}
        }

        // Confirm-mode renewal (Task #3621): starting a card plan for the
        // renewal year marks a pending 'notice_sent' renewal row confirmed.
        try {
          const { markRenewalConfirmed } = await import('../../_lib/gocardlessDdRenewals.js');
          await markRenewalConfirmed({ tenantId: feeToken.tenant_id, memberId: feeToken.member_id, yearLabel, newAgreementId: agreement.id });
        } catch {}

        return res.json({ checkoutUrl: session.url, agreementId: agreement.id });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Public Fee] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
