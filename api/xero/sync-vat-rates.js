import { createClient } from "@supabase/supabase-js";
import { getValidXeroAccessToken } from "../_lib/xero.js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { accessToken, tenantId } = await getValidXeroAccessToken();

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
      console.error("Xero TaxRates API error:", errorText);
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

    const { data: existingSetting } = await supabase
      .from("system_settings")
      .select("*")
      .eq("setting_key", "xero_vat_rates")
      .single();

    if (existingSetting) {
      await supabase
        .from("system_settings")
        .update({ setting_value: JSON.stringify(syncData) })
        .eq("setting_key", "xero_vat_rates");
    } else {
      await supabase.from("system_settings").insert({
        setting_key: "xero_vat_rates",
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
