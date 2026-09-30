import { supabase } from './_lib/database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const { 
      search, 
      sort = 'asc', 
      excludeIds, 
      filters, 
      page = '1', 
      limit = '100' 
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);

    const parsedFilters = filters 
      ? (typeof filters === 'string' ? JSON.parse(filters) : filters)
      : {};
    const filterEntries = Object.entries(parsedFilters).filter(([_, value]) => value && value !== 'all');
    const hasCustomFieldFilters = filterEntries.length > 0;

    let matchingOrgIds = null;

    if (hasCustomFieldFilters) {
      const { data: prefValues, error: prefError } = await supabase
        .from('organization_preference_value')
        .select('organization_id, field_id, value');

      if (prefError) {
        console.error('[OrgDirectory] Error fetching preference values:', prefError);
        return res.status(500).json({ error: prefError.message });
      }

      const orgPrefMap = {};
      (prefValues || []).forEach(pv => {
        if (!orgPrefMap[pv.organization_id]) {
          orgPrefMap[pv.organization_id] = {};
        }
        
        let normalizedValue = pv.value;
        if (typeof pv.value === 'string') {
          const trimmed = pv.value.trim();
          if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            try {
              normalizedValue = JSON.parse(trimmed);
            } catch {
            }
          }
        }
        normalizedValue = extractPrimitiveValue(normalizedValue);
        orgPrefMap[pv.organization_id][pv.field_id] = normalizedValue;
      });

      matchingOrgIds = Object.keys(orgPrefMap).filter(orgId => {
        const orgValues = orgPrefMap[orgId] || {};
        return filterEntries.every(([fieldId, filterValue]) => {
          const orgValue = orgValues[fieldId];
          if (!orgValue) return false;
          if (Array.isArray(orgValue)) {
            return orgValue.includes(filterValue);
          }
          return orgValue === filterValue;
        });
      });

      if (matchingOrgIds.length === 0) {
        return res.json({
          data: [],
          total: 0,
          page: pageNum,
          limit: limitNum,
          totalPages: 0
        });
      }
    }

    let query = supabase.from('organization').select('*', { count: 'exact' });

    if (matchingOrgIds !== null) {
      query = query.in('id', matchingOrgIds);
    }

    if (search) {
      query = query.or(`name.ilike.%${search}%,domain.ilike.%${search}%`);
    }

    if (excludeIds) {
      const excludeArray = Array.isArray(excludeIds) ? excludeIds : excludeIds.split(',');
      if (excludeArray.length > 0) {
        query = query.not('id', 'in', `(${excludeArray.join(',')})`);
      }
    }

    query = query.order('name', { ascending: sort === 'asc' });

    const { data: allMatchingOrgs, error: countError, count: totalCount } = await query;

    if (countError) {
      console.error('[OrgDirectory] Error fetching organizations:', countError);
      return res.status(500).json({ error: countError.message });
    }

    const offset = (pageNum - 1) * limitNum;
    const paginatedOrgs = (allMatchingOrgs || []).slice(offset, offset + limitNum);
    const total = totalCount || (allMatchingOrgs || []).length;

    return res.json({
      data: paginatedOrgs,
      total: total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum)
    });
  } catch (error) {
    console.error('[OrgDirectory] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch organizations' });
  }
}

function extractPrimitiveValue(val) {
  if (val === null || val === undefined) return val;
  
  if (typeof val === 'object' && !Array.isArray(val) && val.value !== undefined) {
    return val.value;
  }
  
  if (Array.isArray(val)) {
    return val.map(item => {
      if (typeof item === 'object' && item !== null && item.value !== undefined) {
        return item.value;
      }
      return item;
    });
  }
  
  return val;
}
