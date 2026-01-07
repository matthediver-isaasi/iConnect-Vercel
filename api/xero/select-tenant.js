import { supabase } from "../_lib/database.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    
    const { tenantId, tenantName } = req.body;
    
    if (!tenantId) {
      return res.status(400).json({ error: "Tenant ID is required" });
    }
    
    // Update the existing token record with the selected tenant
    const { data: existingTokens } = await supabase
      .from("xero_token")
      .select("*");
    
    if (!existingTokens || existingTokens.length === 0) {
      return res.status(400).json({ error: "No pending token found" });
    }
    
    await supabase
      .from("xero_token")
      .update({ tenant_id: tenantId, tenant_name: tenantName })
      .eq("id", existingTokens[0].id);
    
    res.json({ success: true, tenantName });
  } catch (error) {
    console.error("Error selecting Xero tenant:", error);
    res.status(500).json({ error: error.message });
  }
}
