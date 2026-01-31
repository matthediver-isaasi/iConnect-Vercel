import { supabase } from '../_lib/database.js';

function decodeTrackingToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const [campaignId, recipientId] = decoded.split(':');
    return { campaignId, recipientId };
  } catch (err) {
    return null;
  }
}

export default async function handler(req, res) {
  const { t: token, confirm } = req.query;

  if (!token) {
    return res.status(400).send(renderPage('Invalid unsubscribe link', 'error'));
  }

  const tokenData = decodeTrackingToken(token);
  if (!tokenData) {
    return res.status(400).send(renderPage('Invalid unsubscribe link', 'error'));
  }

  const { campaignId, recipientId } = tokenData;

  if (!supabase) {
    return res.status(500).send(renderPage('Service temporarily unavailable', 'error'));
  }

  try {
    const { data: recipient, error: recipientError } = await supabase
      .from('email_campaign_recipient')
      .select('id, email, member_id, campaign_id')
      .eq('id', recipientId)
      .single();

    if (recipientError || !recipient) {
      return res.status(400).send(renderPage('Invalid unsubscribe link', 'error'));
    }

    const { data: campaign } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, name')
      .eq('id', campaignId)
      .single();

    if (!campaign) {
      return res.status(400).send(renderPage('Campaign not found', 'error'));
    }

    if (req.method === 'GET' && confirm !== 'true') {
      return res.send(renderPage('Confirm Unsubscribe', 'confirm', {
        email: recipient.email,
        campaignName: campaign.name,
        token
      }));
    }

    if (req.method === 'GET' && confirm === 'true') {
      await supabase
        .from('email_unsubscribe')
        .upsert({
          tenant_id: campaign.tenant_id,
          email: recipient.email,
          member_id: recipient.member_id,
          unsubscribe_type: 'all',
          campaign_id: campaignId,
          source: 'user',
          unsubscribed_at: new Date().toISOString()
        }, {
          onConflict: 'tenant_id,email,unsubscribe_type,communication_category_id'
        });

      await supabase
        .from('email_campaign_recipient')
        .update({
          status: 'unsubscribed',
          unsubscribed_at: new Date().toISOString()
        })
        .eq('id', recipientId);

      await supabase
        .from('email_campaign')
        .update({
          unsubscribed_count: supabase.raw ? supabase.raw('unsubscribed_count + 1') : 1
        })
        .eq('id', campaignId);

      return res.send(renderPage('Successfully Unsubscribed', 'success', {
        email: recipient.email
      }));
    }

    return res.status(405).send(renderPage('Method not allowed', 'error'));
  } catch (err) {
    console.error('[Unsubscribe] Error:', err);
    return res.status(500).send(renderPage('An error occurred', 'error'));
  }
}

function renderPage(title, type, data = {}) {
  const styles = `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { 
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .container {
        background: white;
        padding: 40px;
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        max-width: 450px;
        text-align: center;
      }
      h1 { 
        margin-bottom: 20px;
        color: #333;
        font-size: 24px;
      }
      p { 
        color: #666;
        margin-bottom: 15px;
        line-height: 1.6;
      }
      .email { 
        font-weight: 600;
        color: #333;
      }
      .btn {
        display: inline-block;
        padding: 12px 30px;
        border-radius: 6px;
        text-decoration: none;
        font-weight: 600;
        margin: 10px 5px;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      }
      .btn-primary {
        background: #ef4444;
        color: white;
      }
      .btn-secondary {
        background: #e5e7eb;
        color: #374151;
      }
      .icon {
        font-size: 48px;
        margin-bottom: 20px;
      }
      .success .icon { color: #10b981; }
      .error .icon { color: #ef4444; }
    </style>
  `;

  if (type === 'confirm') {
    return `
      <!DOCTYPE html>
      <html>
      <head><title>${title}</title>${styles}</head>
      <body>
        <div class="container">
          <div class="icon">📧</div>
          <h1>Unsubscribe from Emails</h1>
          <p>You are about to unsubscribe:</p>
          <p class="email">${data.email}</p>
          <p>from all future marketing emails${data.campaignName ? ` related to "${data.campaignName}"` : ''}.</p>
          <div style="margin-top: 25px;">
            <a href="?t=${data.token}&confirm=true" class="btn btn-primary">Confirm Unsubscribe</a>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  if (type === 'success') {
    return `
      <!DOCTYPE html>
      <html>
      <head><title>${title}</title>${styles}</head>
      <body>
        <div class="container success">
          <div class="icon">✓</div>
          <h1>${title}</h1>
          <p>The email address:</p>
          <p class="email">${data.email}</p>
          <p>has been removed from our mailing list. You will no longer receive marketing emails from us.</p>
        </div>
      </body>
      </html>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head><title>${title}</title>${styles}</head>
    <body>
      <div class="container error">
        <div class="icon">⚠</div>
        <h1>${title}</h1>
        <p>We couldn't process your unsubscribe request. The link may be invalid or expired.</p>
        <p>Please contact support if you continue to receive unwanted emails.</p>
      </div>
    </body>
    </html>
  `;
}
