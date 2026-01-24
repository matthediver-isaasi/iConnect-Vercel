import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function generateToken(contractId, round, secret) {
  const data = `${contractId}:${round}`;
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function verifyToken(contractId, round, token, secret) {
  const expected = generateToken(contractId, round, secret);
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { contract, token, tenant, round } = req.query;

    if (!contract || !token) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    let tenantId = null;
    if (tenant) {
      const { data: tenantData, error: tenantError } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenant)
        .single();

      if (tenantError || !tenantData) {
        return res.status(400).json({ error: 'Invalid tenant' });
      }
      tenantId = tenantData.id;
    }

    const query = supabase
      .from('contract_instance')
      .select(`
        id,
        form_id,
        status,
        timeout_days,
        timeout_notification_round,
        sent_at,
        timeout_notification_sent_at,
        signers
      `)
      .eq('id', contract);

    if (tenantId) {
      query.eq('tenant_id', tenantId);
    }

    const { data: contractInstance, error: contractError } = await query.single();

    if (contractError || !contractInstance) {
      console.error('[Alternative Signer] Contract not found:', contractError);
      return res.status(404).json({ error: 'Contract not found' });
    }

    const secret = process.env.ALTERNATIVE_SIGNER_TOKEN_SECRET || process.env.SESSION_SECRET || 'default-secret';
    const currentRound = contractInstance.timeout_notification_round || 0;
    const tokenRound = round ? parseInt(round, 10) : currentRound;
    
    const isValid = verifyToken(contract, tokenRound.toString(), token, secret);
    
    if (!isValid) {
      console.log('[Alternative Signer] Token verification failed for contract:', contract, 'round:', tokenRound);
      return res.status(400).json({ error: 'Invalid or expired link' });
    }

    if (tokenRound !== currentRound) {
      return res.status(400).json({ error: 'This link has expired. A newer link may have been sent.' });
    }

    if (contractInstance.status === 'received') {
      return res.status(400).json({ error: 'This contract has already been signed' });
    }

    const { data: contractForm, error: formError } = await supabase
      .from('form')
      .select('id, name, contract_settings')
      .eq('id', contractInstance.form_id)
      .single();

    const alternativeSignerMessage = contractForm?.contract_settings?.alternative_signer_message || null;

    return res.status(200).json({
      valid: true,
      contract_id: contractInstance.id,
      contract_name: contractForm?.name || 'Contract',
      status: contractInstance.status,
      alternative_signer_message: alternativeSignerMessage
    });

  } catch (error) {
    console.error('[Alternative Signer] Validation error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
