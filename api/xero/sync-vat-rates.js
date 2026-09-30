import { supabase } from "../_lib/database.js";
import { getAccountingProvider } from "../_lib/accountingProvider.js";
import { getSessionTenantUser, getSessionMember } from "../_lib/session.js";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let appTenantId = null;
  
  const tenantUser = await getSessionTenantUser(req);
  if (tenantUser) {
    appTenantId = tenantUser.tenant_id;
  } else {
    const sessionMember = await getSessionMember(req);
    if (sessionMember) {
      appTenantId = sessionMember.tenant_id;
    }
  }
  
  if (!appTenantId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    let accessToken, tenantId;
    
    try {
      const _provider = await getAccountingProvider(appTenantId);
      const tokenResult = await _provider.getRawAccessToken(appTenantId);
      accessToken = tokenResult.accessToken;
      tenantId = tokenResult.tenantId;
    } catch (tokenError) {
      console.error("Xero token error:", tokenError);
      return res.status(401).json({
        success: false,
        error: "Xero authentication failed. Please re-authenticate with Xero in Admin Settings.",
        details: tokenError.message,
      });
    }

    const taxRatesResponse = await fetch(
      "https://api.xero.com/api.xro/2.0/TaxRates",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": tenantId,
          Accept: "application/json",
        },
      }
    );

    if (!taxRatesResponse.ok) {
      const errorText = await taxRatesResponse.text();
      console.error("Xero TaxRates API error:", taxRatesResponse.status, errorText);
      
      if (taxRatesResponse.status === 401) {
        return res.status(401).json({
          success: false,
          error: "Xero session expired. Please re-authenticate with Xero in Admin Setup.",
          details: errorText,
        });
      }
      
      throw new Error(`Failed to fetch tax rates from Xero: ${taxRatesResponse.status}`);
    }

    const taxRatesData = await taxRatesResponse.json();
    const taxRates = taxRatesData.TaxRates || [];

    const rates = taxRates.map((rate) => ({
      name: rate.Name,
      taxType: rate.TaxType,
      effectiveRate: rate.EffectiveRate,
      status: rate.Status,
      canApplyToAssets: rate.CanApplyToAssets,
      canApplyToEquity: rate.CanApplyToEquity,
      canApplyToExpenses: rate.CanApplyToExpenses,
      canApplyToLiabilities: rate.CanApplyToLiabilities,
      canApplyToRevenue: rate.CanApplyToRevenue,
    }));

    const syncData = {
      rates,
      count: rates.length,
      syncedAt: new Date().toISOString(),
    };

    // Write to BOTH the per-tenant suffixed key AND the unsuffixed
    // `xero_vat_rates` key that every UI VAT-dropdown reader expects.
    //   - The suffixed key keeps its legacy behaviour (no tenant_id column
    //     populated) so server-side pricing simulators in
    //     `api/_lib/membershipSimulation.js` — which look up by setting_key
    //     only — continue to resolve correctly.
    //   - The unsuffixed key MUST be tenant-scoped at the row level (tenant_id
    //     column populated, queried with `.eq('tenant_id', appTenantId)`)
    //     because multiple tenants will write the same setting_key and we
    //     must not overwrite each other's rates. UI readers go through base44
    //     entities which auto-scope by tenant_id, so the per-tenant row is
    //     what they will see.
    const vatRatesKey = `xero_vat_rates_${appTenantId}`;
    const unsuffixedKey = 'xero_vat_rates';
    const serialized = JSON.stringify(syncData);

    const writeTargets = [
      { key: vatRatesKey, scoped: false },
      { key: unsuffixedKey, scoped: true },
    ];

    for (const { key, scoped } of writeTargets) {
      let lookup = supabase
        .from('system_settings')
        .select('id')
        .eq('setting_key', key);
      if (scoped) lookup = lookup.eq('tenant_id', appTenantId);
      const { data: existingSetting, error: lookupError } = await lookup.maybeSingle();
      if (lookupError) {
        console.error(`[Xero VAT sync] lookup failed for key=${key}:`, lookupError);
        throw new Error(`Failed to look up existing system_settings row for ${key}`);
      }

      if (existingSetting) {
        await supabase
          .from('system_settings')
          .update({ setting_value: serialized })
          .eq('id', existingSetting.id);
      } else {
        const insertRow = { setting_key: key, setting_value: serialized };
        if (scoped) insertRow.tenant_id = appTenantId;
        await supabase.from('system_settings').insert(insertRow);
      }
    }

    return res.status(200).json({
      success: true,
      count: rates.length,
      rates,
      syncedAt: syncData.syncedAt,
    });
  } catch (error) {
    console.error("Xero VAT rates sync error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to sync VAT rates from Xero",
    });
  }
}
