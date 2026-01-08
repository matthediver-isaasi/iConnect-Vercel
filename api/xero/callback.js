import { supabase } from "../_lib/database.js";

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const XERO_REDIRECT_URI = process.env.XERO_REDIRECT_URI;

export default async function handler(req, res) {
  
  const { code, error, state } = req.query;
  
  let appTenantId = null;
  if (state) {
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
      appTenantId = stateData.tenantId;
    } catch (e) {
      console.error('[Xero Callback] Failed to parse state:', e);
    }
  }

  if (error) {
    return res.send(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1 style="color: #dc2626;">Authentication Error</h1>
          <p>Failed to authenticate with Xero: ${error}</p>
          <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
            Close Window
          </button>
        </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).json({ error: "No authorization code provided" });
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString("base64")
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: XERO_REDIRECT_URI || ""
      }).toString()
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || tokenData.error) {
      return res.send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1 style="color: #dc2626;">Token Exchange Failed</h1>
            <p>Error: ${JSON.stringify(tokenData)}</p>
            <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Close Window
            </button>
          </body>
        </html>
      `);
    }

    // Get tenant connections
    const connectionsResponse = await fetch("https://api.xero.com/connections", {
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json"
      }
    });

    const connections = await connectionsResponse.json();

    if (!connections || connections.length === 0) {
      return res.send(`
        <html>
          <body style="font-family: system-ui; padding: 40px; text-align: center;">
            <h1 style="color: #dc2626;">No Xero Organizations Found</h1>
            <p>Please ensure your Xero account has at least one organization.</p>
            <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
              Close Window
            </button>
          </body>
        </html>
      `);
    }

    // Calculate expiration
    const expiresAt = new Date(Date.now() + (tokenData.expires_in * 1000)).toISOString();

    // Get existing tokens for this app tenant
    let existingTokenQuery = supabase.from("xero_token").select("*");
    if (appTenantId) {
      existingTokenQuery = existingTokenQuery.eq("app_tenant_id", appTenantId);
    }
    const { data: existingTokens } = await existingTokenQuery;

    // If multiple tenants, show selection page
    if (connections.length > 1) {
      // Store tokens temporarily with pending selection marker
      const tempRecord = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at: expiresAt,
        tenant_id: "PENDING_SELECTION",
        token_type: tokenData.token_type || "Bearer",
        app_tenant_id: appTenantId
      };

      if (existingTokens && existingTokens.length > 0) {
        await supabase
          .from("xero_token")
          .update(tempRecord)
          .eq("id", existingTokens[0].id);
      } else {
        await supabase
          .from("xero_token")
          .insert(tempRecord);
      }

      // Show tenant selection page
      const tenantOptions = connections.map((c) => `
        <button onclick="selectTenant('${c.tenantId}', '${c.tenantName.replace(/'/g, "\\'")}')" 
                style="display: block; width: 100%; margin: 10px 0; padding: 15px 20px; 
                       background: white; border: 2px solid #e2e8f0; border-radius: 8px; 
                       cursor: pointer; text-align: left; font-size: 16px;
                       transition: all 0.2s;">
          <strong>${c.tenantName}</strong>
          <span style="color: #64748b; font-size: 14px; display: block; margin-top: 4px;">
            ${c.tenantType === "ORGANISATION" ? "Organization" : c.tenantType}
          </span>
        </button>
      `).join("");

      return res.send(`
        <html>
          <head>
            <style>
              body {
                font-family: system-ui;
                padding: 40px;
                max-width: 500px;
                margin: 0 auto;
                background: linear-gradient(to br, #f8fafc, #eff6ff);
              }
              h1 { color: #1e40af; margin-bottom: 10px; }
              p { color: #64748b; margin-bottom: 30px; }
              button:hover { border-color: #2563eb !important; background: #f8fafc !important; }
            </style>
          </head>
          <body>
            <h1>Select Xero Organization</h1>
            <p>You have multiple Xero organizations. Please select which one to use for invoicing:</p>
            ${tenantOptions}
            <script>
              async function selectTenant(tenantId, tenantName) {
                try {
                  const response = await fetch('/api/xero/select-tenant', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tenantId, tenantName, appTenantId: '${appTenantId || ''}' })
                  });
                  
                  if (response.ok) {
                    document.body.innerHTML = \`
                      <h1 style="color: #16a34a;">Xero Connected Successfully</h1>
                      <p>Connected to: <strong>\${tenantName}</strong></p>
                      <p style="font-size: 14px; color: #64748b;">You can now close this window.</p>
                      <button onclick="window.close()" style="margin-top: 20px; padding: 12px 24px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">Close Window</button>
                    \`;
                    setTimeout(() => window.close(), 3000);
                  } else {
                    alert('Failed to select tenant. Please try again.');
                  }
                } catch (error) {
                  alert('Error: ' + error.message);
                }
              }
            </script>
          </body>
        </html>
      `);
    }

    // Single tenant - use it directly
    const tenantId = connections[0].tenantId;
    const tenantName = connections[0].tenantName;

    const tokenRecord = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: expiresAt,
      tenant_id: tenantId,
      tenant_name: tenantName,
      token_type: tokenData.token_type || "Bearer",
      app_tenant_id: appTenantId
    };

    if (existingTokens && existingTokens.length > 0) {
      await supabase
        .from("xero_token")
        .update(tokenRecord)
        .eq("id", existingTokens[0].id);
    } else {
      await supabase
        .from("xero_token")
        .insert(tokenRecord);
    }

    res.send(`
      <html>
        <head>
          <style>
            body {
              font-family: system-ui;
              padding: 40px;
              text-align: center;
              background: linear-gradient(to br, #f8fafc, #eff6ff);
            }
            .success { color: #16a34a; margin-bottom: 10px; }
            button {
              margin-top: 20px;
              padding: 12px 24px;
              background: #2563eb;
              color: white;
              border: none;
              border-radius: 6px;
              cursor: pointer;
              font-size: 16px;
            }
            button:hover { background: #1d4ed8; }
          </style>
        </head>
        <body>
          <h1 class="success">Xero Connected Successfully</h1>
          <p>Your Xero account (${connections[0].tenantName}) has been connected.</p>
          <p style="font-size: 14px; color: #64748b;">You can now close this window.</p>
          <button onclick="window.close()">Close Window</button>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Xero OAuth callback error:", error);
    res.status(500).send(`
      <html>
        <body style="font-family: system-ui; padding: 40px; text-align: center;">
          <h1 style="color: #dc2626;">Authentication Error</h1>
          <p>${error.message}</p>
          <button onclick="window.close()" style="margin-top: 20px; padding: 10px 20px; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer;">
            Close Window
          </button>
        </body>
      </html>
    `);
  }
}
