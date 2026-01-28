import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;
    const { fieldName = 'org_type' } = req.query;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const { data: customFields, error: cfError } = await supabase
      .from('organization_custom_field')
      .select('id, name, label, field_type')
      .eq('tenant_id', tenantId);

    if (cfError) {
      console.error('Error fetching custom fields:', cfError);
    }

    const availableFields = customFields?.map(cf => ({
      name: cf.name,
      label: cf.label || cf.name,
      fieldType: cf.field_type,
      id: cf.id
    })) || [];

    const targetField = customFields?.find(cf => cf.name === fieldName);
    const targetFieldId = targetField?.id;

    if (!targetFieldId) {
      return res.status(200).json({
        fieldName,
        availableFields,
        categories: [],
        summaryCards: [],
        yearlyChartData: [],
        currentYear,
        currentYearMonthlyData: [],
        currentYearQuarterlyData: [],
        totalNewThisYear: 0,
        totalNewThisMonth: 0,
        lastUpdated: now.toISOString(),
        error: `Field "${fieldName}" not found`
      });
    }

    const { data: organizations, error: orgError } = await supabase
      .from('organization')
      .select('id, name, created_at')
      .eq('tenant_id', tenantId);

    if (orgError) {
      console.error('Error fetching organizations:', orgError);
      return res.status(500).json({ error: 'Failed to fetch organizations' });
    }

    const orgIds = (organizations || []).map(org => org.id);

    if (orgIds.length === 0) {
      return res.status(200).json({
        fieldName,
        availableFields,
        categories: [],
        summaryCards: [],
        yearlyChartData: [],
        currentYear,
        currentYearMonthlyData: [],
        currentYearQuarterlyData: [],
        totalNewThisYear: 0,
        totalNewThisMonth: 0,
        lastUpdated: now.toISOString()
      });
    }

    const { data: prefValues, error: prefError } = await supabase
      .from('organization_preference_value')
      .select('organization_id, value')
      .eq('field_id', targetFieldId)
      .in('organization_id', orgIds);

    if (prefError) {
      console.error('Error fetching preference values:', prefError);
      return res.status(500).json({ error: 'Failed to fetch custom field values' });
    }

    const orgValueMap = {};
    (prefValues || []).forEach(pv => {
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
      orgValueMap[pv.organization_id] = normalizedValue;
    });

    const normalizeValue = (val) => {
      if (val === null || val === undefined || val === '') return ['Unspecified'];
      if (Array.isArray(val)) {
        const values = val.map(v => String(v).trim()).filter(Boolean);
        return values.length > 0 ? values : ['Unspecified'];
      }
      if (typeof val === 'object') return ['Unspecified'];
      const strVal = String(val).trim();
      return strVal ? [strVal] : ['Unspecified'];
    };

    const yearlyData = {};
    const monthlyData = {};
    const thisYearCounts = {};
    const thisMonthCounts = {};

    (organizations || []).forEach(org => {
      const rawValue = orgValueMap[org.id];
      const values = normalizeValue(rawValue);

      if (org.created_at) {
        const createdDate = new Date(org.created_at);
        const year = createdDate.getFullYear();
        const month = createdDate.getMonth() + 1;

        values.forEach(typeValue => {
          if (!yearlyData[typeValue]) {
            yearlyData[typeValue] = {};
          }
          if (!yearlyData[typeValue][year]) {
            yearlyData[typeValue][year] = 0;
          }
          yearlyData[typeValue][year]++;

          if (year === currentYear) {
            if (!thisYearCounts[typeValue]) {
              thisYearCounts[typeValue] = 0;
            }
            thisYearCounts[typeValue]++;

            if (!monthlyData[typeValue]) {
              monthlyData[typeValue] = {};
            }
            if (!monthlyData[typeValue][month]) {
              monthlyData[typeValue][month] = 0;
            }
            monthlyData[typeValue][month]++;

            if (month === currentMonth) {
              if (!thisMonthCounts[typeValue]) {
                thisMonthCounts[typeValue] = 0;
              }
              thisMonthCounts[typeValue]++;
            }
          }
        });
      }
    });

    const allCategories = new Set([...Object.keys(yearlyData)]);
    const categories = Array.from(allCategories).filter(k => k !== 'Unspecified').sort();
    if (allCategories.has('Unspecified')) {
      categories.push('Unspecified');
    }

    const summaryCards = categories.map(category => ({
      name: category,
      thisYear: thisYearCounts[category] || 0,
      thisMonth: thisMonthCounts[category] || 0
    }));

    const allYears = new Set();
    Object.values(yearlyData).forEach(typeYears => {
      Object.keys(typeYears).forEach(year => allYears.add(parseInt(year)));
    });
    const sortedYears = Array.from(allYears).sort((a, b) => a - b);

    const yearlyChartData = sortedYears.map(year => {
      const dataPoint = { year: year.toString() };
      categories.forEach(category => {
        dataPoint[category] = yearlyData[category]?.[year] || 0;
      });
      return dataPoint;
    });

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const currentYearMonthlyData = monthNames.map((monthName, index) => {
      const monthNum = index + 1;
      const dataPoint = { month: monthName };
      categories.forEach(category => {
        dataPoint[category] = monthlyData[category]?.[monthNum] || 0;
      });
      return dataPoint;
    });

    const quarterlyData = [
      { quarter: 'Q1', ...Object.fromEntries(categories.map(c => [c, 0])) },
      { quarter: 'Q2', ...Object.fromEntries(categories.map(c => [c, 0])) },
      { quarter: 'Q3', ...Object.fromEntries(categories.map(c => [c, 0])) },
      { quarter: 'Q4', ...Object.fromEntries(categories.map(c => [c, 0])) }
    ];

    categories.forEach(category => {
      for (let month = 1; month <= 12; month++) {
        const quarterIndex = Math.floor((month - 1) / 3);
        quarterlyData[quarterIndex][category] += monthlyData[category]?.[month] || 0;
      }
    });

    const totalNewThisYear = Object.values(thisYearCounts).reduce((sum, count) => sum + count, 0);
    const totalNewThisMonth = Object.values(thisMonthCounts).reduce((sum, count) => sum + count, 0);

    return res.status(200).json({
      fieldName,
      availableFields,
      categories,
      summaryCards,
      yearlyChartData,
      currentYear,
      currentYearMonthlyData,
      currentYearQuarterlyData: quarterlyData,
      totalNewThisYear,
      totalNewThisMonth,
      lastUpdated: now.toISOString()
    });

  } catch (error) {
    console.error('Error in new-org-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
