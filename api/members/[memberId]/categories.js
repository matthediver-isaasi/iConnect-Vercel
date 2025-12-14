import { getSessionMember } from '../../_lib/session.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const { memberId } = req.query;

  if (!memberId) {
    return res.status(400).json({ error: 'Member ID is required' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('member_resource_category')
        .select('id, resource_category_id, subcategory_name, created_at')
        .eq('member_id', memberId);

      if (error) {
        console.error('[Member Categories GET] Error:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.json(data || []);
    } catch (error) {
      console.error('[Member Categories GET] Error:', error);
      return res.status(500).json({ error: 'Failed to get member categories' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { selections } = req.body;

      if (!selections || !Array.isArray(selections)) {
        return res.status(400).json({ error: 'selections must be an array of {category_id, subcategory_name}' });
      }

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validSelections = [];
      const seenKeys = new Set();

      for (const sel of selections) {
        if (sel && typeof sel.category_id === 'string' && uuidRegex.test(sel.category_id)) {
          const subcatName = typeof sel.subcategory_name === 'string' && sel.subcategory_name.trim().length > 0
            ? sel.subcategory_name.trim()
            : null;
          const key = `${sel.category_id}|${subcatName || ''}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            validSelections.push({
              category_id: sel.category_id,
              subcategory_name: subcatName
            });
          }
        }
      }

      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id')
        .eq('id', memberId)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Member not found' });
      }

      if (validSelections.length > 0) {
        const categoryIds = [...new Set(validSelections.map(s => s.category_id))];
        const { data: existingCategories, error: catError } = await supabase
          .from('resource_category')
          .select('id, subcategories')
          .in('id', categoryIds);

        if (catError) {
          console.error('[Member Categories] Category validation error:', catError);
          return res.status(500).json({ error: 'Failed to validate categories' });
        }

        const categoryMap = new Map((existingCategories || []).map(c => [c.id, c.subcategories || []]));
        const finalSelections = validSelections.filter(sel => {
          const subcats = categoryMap.get(sel.category_id);
          if (subcats === undefined) return false;
          
          if (subcats.length === 0) {
            return sel.subcategory_name === null;
          }
          
          return sel.subcategory_name !== null && subcats.includes(sel.subcategory_name);
        });

        if (finalSelections.length !== validSelections.length) {
          console.log(`[Member Categories] Filtered out ${validSelections.length - finalSelections.length} invalid subcategory selections`);
        }

        const { error: deleteError } = await supabase
          .from('member_resource_category')
          .delete()
          .eq('member_id', memberId);

        if (deleteError) {
          console.error('[Member Categories] Delete error:', deleteError);
          return res.status(500).json({ error: 'Failed to clear existing selections' });
        }

        if (finalSelections.length > 0) {
          const insertData = finalSelections.map(sel => ({
            member_id: memberId,
            resource_category_id: sel.category_id,
            subcategory_name: sel.subcategory_name
          }));

          const { error: insertError } = await supabase
            .from('member_resource_category')
            .insert(insertData);

          if (insertError) {
            console.error('[Member Categories] Insert error:', insertError);
            return res.status(500).json({ error: 'Failed to save category selections' });
          }
        }

        console.log(`[Member Categories] Saved ${finalSelections.length} subcategory selections for member ${memberId}`);
        return res.json({ success: true, count: finalSelections.length });
      } else {
        const { error: deleteError } = await supabase
          .from('member_resource_category')
          .delete()
          .eq('member_id', memberId);

        if (deleteError) {
          console.error('[Member Categories] Delete all error:', deleteError);
          return res.status(500).json({ error: 'Failed to clear category selections' });
        }

        console.log(`[Member Categories] Cleared all selections for member ${memberId}`);
        return res.json({ success: true, count: 0 });
      }
    } catch (error) {
      console.error('[Member Categories] Error:', error);
      return res.status(500).json({ error: 'Failed to update member categories' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
