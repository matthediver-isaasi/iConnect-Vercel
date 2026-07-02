import { supabase } from "../_lib/database.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { tenantId, tenantName, appTenantId } = req.body;
    
    if (!tenantId) {
      return res.status(400).json({ error: "Tenant ID is required" });
    }
    
    // Find the pending token record for this app tenant
    let query = supabase.from("xero_token").select("*").eq("tenant_id", "PENDING_SELECTION");
    if (appTenantId) {
      query = query.eq("app_tenant_id", appTenantId);
    }
    
    const { data: existingTokens } = await query;
    
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
