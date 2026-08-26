import { supabase } from '../_lib/database.js';
import crypto from 'crypto';
import {
  loadExternalSubscriberPreferences,
} from '../_lib/externalSubscriberPreferences.js';

const TOKEN_SECRET = process.env.EMAIL_PREFERENCES_TOKEN_SECRET || process.env.SESSION_SECRET || 'default-preferences-secret';

function hmacSign(data) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('hex').substring(0, 16);
}

function decodeTrackingToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts[0] === 'm' && parts.length === 4) {
      const payload = `m:${parts[1]}:${parts[2]}`;
      const expectedSig = hmacSign(payload);
      if (parts[3] !== expectedSig) {
        console.warn('[Preferences] Invalid member token signature');
        return null;
      }
      return { type: 'member', tenantId: parts[1], memberId: parts[2] };
    }
    const [campaignId, recipientId] = parts;
    return { type: 'campaign', campaignId, recipientId };
  } catch (err) {
    return null;
  }
}

export function generateMemberPreferencesToken(tenantId, memberId) {
  const payload = `m:${tenantId}:${memberId}`;
  const sig = hmacSign(payload);
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

export default async function handler(req, res) {
  const { t: token } = req.query;

  if (!token) {
    return res.status(400).json({ success: false, error: 'Invalid link' });
  }

  const tokenData = decodeTrackingToken(token);
  if (!tokenData) {
    return res.status(400).json({ success: false, error: 'Invalid link' });
  }

  if (!supabase) {
    return res.status(500).json({ success: false, error: 'Service temporarily unavailable' });
  }

  if (tokenData.type === 'member') {
    return handleMemberToken(req, res, token, tokenData);
  }

  return handleCampaignToken(req, res, token, tokenData);
}

async function handleMemberToken(req, res, token, tokenData) {
  const { tenantId, memberId } = tokenData;

  try {
    const { data: member, error: memberError } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, communications_opted_out_all, tenant_id')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .single();

    if (memberError || !member) {
      return res.status(400).json({ success: false, error: 'Invalid or expired link' });
    }

    const { data: categories } = await supabase
      .from('communication_category')
      .select('id, name, description, display_order')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    const { data: prefs } = await supabase
      .from('member_communication_preference')
      .select('id, category_id, is_subscribed')
      .eq('member_id', member.id);

    const memberPreferences = prefs || [];

    if (req.method === 'POST') {
      return handlePreferenceUpdate(req, res, {
        token,
        member,
        recipient: { email: member.email, member_id: member.id },
        campaign: null,
        categories,
        tenantId
      });
    }

    const categoriesWithStatus = (categories || []).map(cat => {
      const pref = memberPreferences.find(p => p.category_id === cat.id);
      return {
        ...cat,
        isSubscribed: pref ? pref.is_subscribed : false
      };
    });

    const { data: tenant } = await supabase
      .from('tenant')
      .select('id, slug')
      .eq('id', tenantId)
      .single();

    return res.json({
      success: true,
      token,
      email: member.email,
      firstName: member.first_name || '',
      lastName: member.last_name || '',
      optedOutAll: member.communications_opted_out_all || false,
      categories: categoriesWithStatus,
      campaignName: null,
      isMember: true,
      tenantSlug: tenant?.slug || ''
    });

  } catch (err) {
    console.error('[Preferences] Member token error:', err);
    return res.status(500).json({ success: false, error: 'An error occurred' });
  }
}

async function handleCampaignToken(req, res, token, tokenData) {
  const { campaignId, recipientId } = tokenData;

  try {
    const { data: recipient, error: recipientError } = await supabase
      .from('email_campaign_recipient')
      .select('id, email, first_name, last_name, member_id, campaign_id')
      .eq('id', recipientId)
      .single();

    if (recipientError || !recipient) {
      return res.status(400).json({ success: false, error: 'Invalid or expired link' });
    }

    if (recipient.campaign_id !== campaignId) {
      return res.status(400).json({ success: false, error: 'Invalid link' });
    }

    const { data: campaign } = await supabase
      .from('email_campaign')
      .select('id, tenant_id, name')
      .eq('id', campaignId)
      .single();

    if (!campaign) {
      return res.status(400).json({ success: false, error: 'Campaign not found' });
    }

    const tenantId = campaign.tenant_id;

    const { data: categories } = await supabase
      .from('communication_category')
      .select('id, name, description, display_order')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('display_order', { ascending: true });

    let memberPreferences = [];
    let member = null;
    let externalPreferences = null;

    if (recipient.member_id) {
      const { data: memberData } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, communications_opted_out_all')
        .eq('id', recipient.member_id)
        .single();
      
      member = memberData;

      if (member) {
        const { data: prefs } = await supabase
          .from('member_communication_preference')
          .select('id, category_id, is_subscribed')
          .eq('member_id', member.id);
        
        memberPreferences = prefs || [];
      }
    } else {
      externalPreferences = await loadExternalSubscriberPreferences(supabase, {
        tenantId,
        email: recipient.email,
        activeCategories: categories,
      });
    }

    if (req.method === 'POST') {
      return handlePreferenceUpdate(req, res, {
        token,
        member,
        recipient,
        campaign,
        categories,
        tenantId
      });
    }

    const categoriesWithStatus = member ? (categories || []).map(cat => {
      const pref = memberPreferences.find(p => p.category_id === cat.id);
      return {
        ...cat,
        isSubscribed: pref ? pref.is_subscribed : false
      };
    }) : externalPreferences.categories;

    const { data: tenant } = await supabase
      .from('tenant')
      .select('id, slug')
      .eq('id', tenantId)
      .single();

    return res.json({
      success: true,
      token,
      email: recipient.email,
      firstName: member?.first_name || recipient.first_name || '',
      lastName: member?.last_name || recipient.last_name || '',
      optedOutAll: member ? (member.communications_opted_out_all || false) : externalPreferences.optedOutAll,
      categories: categoriesWithStatus,
      campaignName: campaign.name,
      isMember: !!member,
      tenantSlug: tenant?.slug || ''
    });

  } catch (err) {
    console.error('[Preferences] Campaign token error:', err);
    return res.status(500).json({ success: false, error: 'An error occurred' });
  }
}

function preferenceUpdateFailure(error, operation) {
  const message = String(error?.message || '');
  const expectedValidation = [
    'invalid email preference global state input',
    'invalid email preference category state input',
    'invalid communication category',
    'member not found',
    'external subscriber category not found',
  ].some((value) => message.includes(value));

  console.error('[Preferences] Atomic update failed', {
    operation,
    code: error?.code || null,
    message: error?.message || String(error),
    details: error?.details || null,
    hint: error?.hint || null,
  });

  if (message.includes('global email opt-out is active')) {
    return {
      status: 409,
      payload: {
        success: false,
        error: 'Turn off the global email opt-out before changing individual categories.',
      },
    };
  }
  if (expectedValidation) {
    return {
      status: 400,
      payload: {
        success: false,
        error: 'These email preferences could not be updated. Refresh the page and try again.',
      },
    };
  }
  return {
    status: 503,
    payload: {
      success: false,
      error: 'Email preferences are temporarily unavailable. Please try again.',
    },
  };
}

export async function handlePreferenceUpdate(req, res, context) {
  const { token, member, recipient, campaign, categories, tenantId } = context;
  const database = context.database || supabase;
  let operation = 'unknown';
  
  try {
    let body = req.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }

    const { action, categoryId, optOutAll } = body;

    if (action === 'toggle_all') {
      operation = 'set_global_state';
      if (typeof optOutAll !== 'boolean') {
        return res.status(400).json({ success: false, error: 'An opt-out state is required.' });
      }
      let availableCategories = categories || [];
      if (!member) {
        const currentPreferences = await loadExternalSubscriberPreferences(database, {
          tenantId,
          email: recipient.email,
          activeCategories: categories,
        });
        availableCategories = currentPreferences.categories;
      }

      const { error: globalUpdateError } = await database.rpc(
        'set_email_preference_global_state',
        {
          p_tenant_id: tenantId,
          p_email: member?.email || recipient.email,
          p_member_id: member?.id || null,
          p_opt_out_all: optOutAll,
          p_campaign_id: campaign?.id || null,
          p_category_ids: availableCategories.map((category) => category.id),
        }
      );
      if (globalUpdateError) throw globalUpdateError;

      let responseCategories;
      if (member) {
        const { data: refreshedPreferences, error: refreshedPreferencesError } = await database
          .from('member_communication_preference')
          .select('category_id, is_subscribed')
          .eq('tenant_id', tenantId)
          .eq('member_id', member.id);
        if (refreshedPreferencesError) throw refreshedPreferencesError;
        responseCategories = (categories || []).map((category) => {
          const preference = refreshedPreferences?.find((item) => item.category_id === category.id);
          return {
            ...category,
            isSubscribed: optOutAll ? false : preference?.is_subscribed === true,
          };
        });
      } else {
        const refreshed = await loadExternalSubscriberPreferences(database, {
          tenantId,
          email: recipient.email,
          activeCategories: categories,
        });
        responseCategories = refreshed.categories;
      }
      return res.json({
        success: true,
        optedOutAll: optOutAll,
        categories: responseCategories,
      });
    }

    if (action === 'set_category_subscription' && categoryId) {
      operation = 'set_category_state';
      const activeCategory = (categories || []).find((category) => category.id === categoryId);
      if (!activeCategory) {
        return res.status(400).json({ success: false, error: 'Communication category not found.' });
      }
      if (typeof body.isSubscribed !== 'boolean') {
        return res.status(400).json({ success: false, error: 'A subscription state is required.' });
      }
      const { error: categoryUpdateError } = await database.rpc(
        'set_email_preference_category_state',
        {
          p_tenant_id: tenantId,
          p_email: member?.email || recipient.email,
          p_member_id: member?.id || null,
          p_category_id: categoryId,
          p_is_subscribed: body.isSubscribed,
          p_campaign_id: campaign?.id || null,
        }
      );
      if (categoryUpdateError) {
        throw categoryUpdateError;
      }
      return res.json({ success: true, categoryId, isSubscribed: body.isSubscribed });
    }

    return res.status(400).json({ error: 'Invalid action' });

  } catch (err) {
    const failure = preferenceUpdateFailure(err, operation);
    return res.status(failure.status).json(failure.payload);
  }
}

function renderPage(type, data = {}) {
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
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        max-width: 550px;
        width: 100%;
      }
      h1 { 
        margin-bottom: 8px;
        color: #1f2937;
        font-size: 24px;
        text-align: center;
      }
      .subtitle {
        color: #6b7280;
        text-align: center;
        margin-bottom: 24px;
        font-size: 14px;
      }
      .email-badge {
        background: #f3f4f6;
        padding: 8px 16px;
        border-radius: 20px;
        display: inline-block;
        margin-bottom: 24px;
        font-size: 14px;
        color: #374151;
      }
      .category-list {
        border-top: 1px solid #e5e7eb;
      }
      .category-item {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        padding: 16px 0;
        border-bottom: 1px solid #e5e7eb;
        gap: 16px;
      }
      .category-info {
        flex: 1;
      }
      .category-name {
        font-weight: 600;
        color: #1f2937;
        margin-bottom: 4px;
      }
      .category-desc {
        font-size: 13px;
        color: #6b7280;
        line-height: 1.4;
      }
      .toggle-switch {
        position: relative;
        width: 48px;
        height: 26px;
        flex-shrink: 0;
      }
      .toggle-switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: #d1d5db;
        transition: 0.3s;
        border-radius: 26px;
      }
      .toggle-slider:before {
        position: absolute;
        content: "";
        height: 20px;
        width: 20px;
        left: 3px;
        bottom: 3px;
        background-color: white;
        transition: 0.3s;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      input:checked + .toggle-slider {
        background-color: #10b981;
      }
      input:checked + .toggle-slider:before {
        transform: translateX(22px);
      }
      input:disabled + .toggle-slider {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .opt-out-section {
        margin-top: 24px;
        padding: 16px;
        background: #fef2f2;
        border-radius: 12px;
        border: 1px solid #fecaca;
      }
      .opt-out-section.opted-out {
        background: #fee2e2;
      }
      .opt-out-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
      }
      .opt-out-title {
        font-weight: 600;
        color: #991b1b;
        margin-bottom: 4px;
      }
      .opt-out-desc {
        font-size: 13px;
        color: #b91c1c;
      }
      .status-message {
        text-align: center;
        padding: 12px;
        border-radius: 8px;
        margin-top: 16px;
        font-size: 14px;
        display: none;
      }
      .status-message.success {
        background: #d1fae5;
        color: #065f46;
        display: block;
      }
      .status-message.error {
        background: #fee2e2;
        color: #991b1b;
        display: block;
      }
      .error-container {
        text-align: center;
      }
      .error-icon {
        font-size: 48px;
        margin-bottom: 16px;
      }
      .error-message {
        color: #6b7280;
        margin-bottom: 8px;
      }
      .loading-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(255,255,255,0.8);
        display: none;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .loading-overlay.active {
        display: flex;
      }
      .spinner {
        width: 40px;
        height: 40px;
        border: 3px solid #e5e7eb;
        border-top-color: #667eea;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      .empty-state {
        text-align: center;
        padding: 32px 16px;
        color: #6b7280;
      }
      .non-member-notice {
        text-align: center;
        padding: 16px;
        background: #f3f4f6;
        border-radius: 8px;
        color: #4b5563;
        font-size: 14px;
        margin-bottom: 8px;
      }
    </style>
  `;

  if (type === 'error') {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Communication Preferences</title>
        ${styles}
      </head>
      <body>
        <div class="container error-container">
          <div class="error-icon">⚠️</div>
          <h1>Unable to Load Preferences</h1>
          <p class="error-message">${data.message || 'Something went wrong'}</p>
          <p class="error-message">Please try clicking the link in your email again, or contact support if the problem persists.</p>
        </div>
      </body>
      </html>
    `;
  }

  const categoriesHtml = data.isMember ? (data.categories || []).map(cat => `
    <div class="category-item" data-category-id="${cat.id}">
      <div class="category-info">
        <div class="category-name">${escapeHtml(cat.name)}</div>
        ${cat.description ? `<div class="category-desc">${escapeHtml(cat.description)}</div>` : ''}
      </div>
      <label class="toggle-switch">
        <input type="checkbox" 
          ${cat.isSubscribed ? 'checked' : ''} 
          ${data.optedOutAll ? 'disabled' : ''}
          onchange="toggleCategory('${cat.id}', this)">
        <span class="toggle-slider"></span>
      </label>
    </div>
  `).join('') : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Communication Preferences</title>
      ${styles}
    </head>
    <body>
      <div class="loading-overlay" id="loadingOverlay">
        <div class="spinner"></div>
      </div>
      
      <div class="container">
        <h1>Communication Preferences</h1>
        <p class="subtitle">Manage your email subscriptions</p>
        
        <div style="text-align: center;">
          <span class="email-badge">${escapeHtml(data.email)}</span>
        </div>

        ${data.isMember && (data.categories || []).length > 0 ? `
          <div class="category-list" id="categoryList">
            ${categoriesHtml}
          </div>
        ` : data.isMember ? `
          <div class="empty-state">
            <p>No communication categories available.</p>
          </div>
        ` : `
          <div class="non-member-notice">
            <p>Use the toggle below to unsubscribe from all marketing emails.</p>
          </div>
        `}

        <div class="opt-out-section ${data.optedOutAll ? 'opted-out' : ''}" id="optOutSection">
          <div class="opt-out-header">
            <div>
              <div class="opt-out-title">Unsubscribe from all</div>
              <div class="opt-out-desc">Stop receiving all marketing emails</div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" 
                id="optOutAllToggle"
                ${data.optedOutAll ? 'checked' : ''} 
                onchange="toggleOptOutAll(this)">
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>

        <div class="status-message" id="statusMessage"></div>
      </div>

      <script>
        const token = '${data.token}';

        function showLoading() {
          document.getElementById('loadingOverlay').classList.add('active');
        }

        function hideLoading() {
          document.getElementById('loadingOverlay').classList.remove('active');
        }

        function showStatus(message, isError) {
          const el = document.getElementById('statusMessage');
          el.textContent = message;
          el.className = 'status-message ' + (isError ? 'error' : 'success');
          setTimeout(() => {
            el.className = 'status-message';
          }, 3000);
        }

        async function toggleCategory(categoryId, checkbox) {
          showLoading();
          try {
            const response = await fetch('?t=' + token, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'set_category_subscription',
                categoryId: categoryId,
                isSubscribed: checkbox.checked
              })
            });
            const result = await response.json();
            if (result.success) {
              checkbox.checked = result.isSubscribed;
              showStatus(result.isSubscribed ? 'Subscribed successfully' : 'Unsubscribed successfully', false);
            } else {
              checkbox.checked = !checkbox.checked;
              showStatus(result.error || 'Failed to update', true);
            }
          } catch (err) {
            checkbox.checked = !checkbox.checked;
            showStatus('Failed to update preferences', true);
          }
          hideLoading();
        }

        async function toggleOptOutAll(checkbox) {
          showLoading();
          try {
            const response = await fetch('?t=' + token, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'toggle_all',
                optOutAll: checkbox.checked
              })
            });
            const result = await response.json();
            if (result.success) {
              const categoryToggles = document.querySelectorAll('#categoryList input[type="checkbox"]');
              categoryToggles.forEach(toggle => {
                toggle.disabled = result.optedOutAll;
                if (result.optedOutAll) {
                  toggle.checked = false;
                }
              });
              
              const section = document.getElementById('optOutSection');
              if (result.optedOutAll) {
                section.classList.add('opted-out');
                showStatus('You have been unsubscribed from all emails', false);
              } else {
                section.classList.remove('opted-out');
                showStatus('You can now manage individual preferences', false);
              }
            } else {
              checkbox.checked = !checkbox.checked;
              showStatus(result.error || 'Failed to update', true);
            }
          } catch (err) {
            checkbox.checked = !checkbox.checked;
            showStatus('Failed to update preferences', true);
          }
          hideLoading();
        }
      </script>
    </body>
    </html>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
