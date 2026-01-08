import { supabase } from "../_lib/database.js";
import { getValidXeroAccessToken } from "../_lib/xero.js";
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
      const tokenResult = await getValidXeroAccessToken(appTenantId);
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

    const vatRatesKey = `xero_vat_rates_${appTenantId}`;
    
    const { data: existingSetting } = await supabase
      .from("system_settings")
      .select("*")
      .eq("setting_key", vatRatesKey)
      .single();

    if (existingSetting) {
      await supabase
        .from("system_settings")
        .update({ setting_value: JSON.stringify(syncData) })
        .eq("setting_key", vatRatesKey);
    } else {
      await supabase.from("system_settings").insert({
        setting_key: vatRatesKey,
        setting_value: JSON.stringify(syncData),
      });
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
