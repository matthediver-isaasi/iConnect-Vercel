import { supabase } from '../_lib/database.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ error: 'Slug is required' });
  }

  if (slug.length < 3) {
    return res.status(200).json({ available: false, reason: 'Too short' });
  }

  const slugRegex = /^[a-z0-9-]+$/;
  if (!slugRegex.test(slug)) {
    return res.status(200).json({ available: false, reason: 'Invalid characters' });
  }

  const reservedSlugs = ['www', 'api', 'app', 'admin', 'mail', 'ftp', 'cdn', 'static', 'assets', 'images', 'login', 'signup', 'register'];
  if (reservedSlugs.includes(slug)) {
    return res.status(200).json({ available: false, reason: 'Reserved' });
  }

  try {
    const { data: existingTenant } = await supabase
      .from('tenant')
      .select('id')
      .eq('slug', slug)
      .single();

    return res.status(200).json({
      available: !existingTenant,
      reason: existingTenant ? 'Already taken' : null
    });
  } catch (err) {
    if (err.code === 'PGRST116') {
      return res.status(200).json({ available: true });
    }
    console.error('[Check Slug] Error:', err);
    return res.status(500).json({ error: 'Failed to check availability' });
  }
}
