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

      const { data: member, error: memberError } = await supabase
        .from('member')
        .select('id')
        .eq('id', memberId)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Member not found' });
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

      const categoryIds = [...new Set(validSelections.map(s => s.category_id))];
      
      let finalSelections = [];
      if (categoryIds.length > 0) {
        const { data: existingCategories, error: catError } = await supabase
          .from('resource_category')
          .select('id, subcategories')
          .in('id', categoryIds);

        if (catError) {
          console.error('[Member Categories] Category validation error:', catError);
          return res.status(500).json({ error: 'Failed to validate categories' });
        }

        const categoryMap = new Map((existingCategories || []).map(c => [c.id, c.subcategories || []]));
        finalSelections = validSelections.filter(sel => {
          const subcats = categoryMap.get(sel.category_id);
          if (subcats === undefined) return false;
          
          if (subcats.length === 0) {
            return sel.subcategory_name === null;
          }
          
          return sel.subcategory_name !== null && subcats.includes(sel.subcategory_name);
        });
      }

      const { data: currentSelections, error: fetchError } = await supabase
        .from('member_resource_category')
        .select('id, resource_category_id, subcategory_name')
        .eq('member_id', memberId);

      if (fetchError) {
        console.error('[Member Categories] Fetch current error:', JSON.stringify(fetchError));
        return res.status(500).json({ 
          error: 'Failed to fetch current selections', 
          details: fetchError.message,
          code: fetchError.code 
        });
      }
      
      // Empty result is valid - treat as empty array
      const existing = currentSelections || [];

      const currentKeys = new Set(
        existing.map(s => `${s.resource_category_id}|${s.subcategory_name || ''}`)
      );
      const newKeys = new Set(
        finalSelections.map(s => `${s.category_id}|${s.subcategory_name || ''}`)
      );

      const toAdd = finalSelections.filter(s => 
        !currentKeys.has(`${s.category_id}|${s.subcategory_name || ''}`)
      );
      
      const toRemove = existing.filter(s => 
        !newKeys.has(`${s.resource_category_id}|${s.subcategory_name || ''}`)
      );

      if (toRemove.length > 0) {
        const removeIds = toRemove.map(s => s.id);
        const { error: deleteError } = await supabase
          .from('member_resource_category')
          .delete()
          .in('id', removeIds);

        if (deleteError) {
          console.error('[Member Categories] Delete error:', deleteError);
          return res.status(500).json({ error: 'Failed to remove unselected categories' });
        }
        console.log(`[Member Categories] Removed ${toRemove.length} selections`);
      }

      if (toAdd.length > 0) {
        const insertData = toAdd.map(sel => ({
          member_id: memberId,
          resource_category_id: sel.category_id,
          subcategory_name: sel.subcategory_name
        }));

        const { error: insertError } = await supabase
          .from('member_resource_category')
          .insert(insertData);

        if (insertError) {
          console.error('[Member Categories] Insert error:', insertError);
          return res.status(500).json({ error: 'Failed to add new category selections' });
        }
        console.log(`[Member Categories] Added ${toAdd.length} selections`);
      }

      console.log(`[Member Categories] Updated member ${memberId}: +${toAdd.length} -${toRemove.length}, total: ${finalSelections.length}`);
      return res.json({ success: true, count: finalSelections.length, added: toAdd.length, removed: toRemove.length });
    } catch (error) {
      console.error('[Member Categories] Error:', error);
      return res.status(500).json({ error: 'Failed to update member categories' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
