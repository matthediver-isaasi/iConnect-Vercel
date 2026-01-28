import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

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

    const { data: organizations, error: orgError } = await supabase
      .from('organization')
      .select('id, custom_fields, created_at')
      .eq('tenant_id', tenantId);

    if (orgError) {
      console.error('Error fetching organizations:', orgError);
      return res.status(500).json({ error: 'Failed to fetch organizations' });
    }

    const { data: customFields, error: cfError } = await supabase
      .from('custom_field')
      .select('id, name, label, field_type')
      .eq('tenant_id', tenantId)
      .eq('entity_type', 'organization');

    if (cfError) {
      console.error('Error fetching custom fields:', cfError);
    }

    const availableFields = customFields?.map(cf => ({
      name: cf.name,
      label: cf.label || cf.name,
      fieldType: cf.field_type
    })) || [];

    const typeCounts = {};
    const yearlyData = {};
    const monthlyData = {};

    const normalizeValue = (val) => {
      if (val === null || val === undefined || val === '') return 'Unspecified';
      if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
      if (typeof val === 'object') return 'Unspecified';
      return String(val).trim() || 'Unspecified';
    };

    organizations?.forEach(org => {
      const customFieldsData = org.custom_fields || {};
      const rawValue = customFieldsData[fieldName];
      const normalizedValues = normalizeValue(rawValue);
      const values = Array.isArray(normalizedValues) ? normalizedValues : [normalizedValues];
      
      values.forEach(typeValue => {
        if (!typeCounts[typeValue]) {
          typeCounts[typeValue] = 0;
        }
        typeCounts[typeValue]++;

        if (org.created_at) {
          const createdDate = new Date(org.created_at);
          const year = createdDate.getFullYear();
          const month = createdDate.getMonth() + 1;

          if (!yearlyData[typeValue]) {
            yearlyData[typeValue] = {};
          }
          if (!yearlyData[typeValue][year]) {
            yearlyData[typeValue][year] = 0;
          }
          yearlyData[typeValue][year]++;

          if (year === currentYear) {
            if (!monthlyData[typeValue]) {
              monthlyData[typeValue] = {};
            }
            if (!monthlyData[typeValue][month]) {
              monthlyData[typeValue][month] = 0;
            }
            monthlyData[typeValue][month]++;
          }
        }
      });
    });

    const categories = Object.keys(typeCounts).filter(k => k !== 'Unspecified').sort();
    if (typeCounts['Unspecified']) {
      categories.push('Unspecified');
    }

    const summaryCards = categories.map(category => ({
      name: category,
      total: typeCounts[category] || 0
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

    return res.status(200).json({
      fieldName,
      availableFields,
      categories,
      summaryCards,
      yearlyChartData,
      currentYear,
      currentYearMonthlyData,
      currentYearQuarterlyData: quarterlyData,
      totalOrganizations: organizations?.length || 0,
      lastUpdated: now.toISOString()
    });

  } catch (error) {
    console.error('Error in org-type-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
