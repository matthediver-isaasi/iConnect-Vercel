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

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
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
    const currentWeekStart = getWeekStart(now);

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
        currentYearWeeklyData: [],
        allTimeData: [],
        totalMembers: 0,
        lastUpdated: now.toISOString(),
        error: `Field "${fieldName}" not found`
      });
    }

    const { data: organizations, error: orgError } = await supabase
      .from('organization')
      .select('id, name')
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
        currentYearWeeklyData: [],
        allTimeData: [],
        totalMembers: 0,
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

    const { data: members, error: memberError } = await supabase
      .from('member')
      .select('id, organization_id, created_at')
      .in('organization_id', orgIds);

    if (memberError) {
      console.error('Error fetching members:', memberError);
      return res.status(500).json({ error: 'Failed to fetch members' });
    }

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

    const typeCounts = {};
    const yearlyData = {};
    const monthlyData = {};
    const weeklyData = {};

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    (members || []).forEach(member => {
      const rawValue = orgValueMap[member.organization_id];
      const values = normalizeValue(rawValue);

      values.forEach(typeValue => {
        if (!typeCounts[typeValue]) {
          typeCounts[typeValue] = 0;
        }
        typeCounts[typeValue]++;

        if (member.created_at) {
          const createdDate = new Date(member.created_at);
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

            const memberWeekStart = getWeekStart(createdDate);
            if (memberWeekStart.getTime() === currentWeekStart.getTime()) {
              const dayOfWeek = createdDate.getDay();
              const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
              const dayName = dayNames[dayIndex];
              
              if (!weeklyData[typeValue]) {
                weeklyData[typeValue] = {};
              }
              if (!weeklyData[typeValue][dayName]) {
                weeklyData[typeValue][dayName] = 0;
              }
              weeklyData[typeValue][dayName]++;
            }
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

    const currentYearWeeklyData = dayNames.map(dayName => {
      const dataPoint = { day: dayName };
      categories.forEach(category => {
        dataPoint[category] = weeklyData[category]?.[dayName] || 0;
      });
      return dataPoint;
    });

    const allTimeData = [{ period: 'All Time' }];
    categories.forEach(category => {
      allTimeData[0][category] = typeCounts[category] || 0;
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
      currentYearWeeklyData,
      allTimeData,
      totalMembers: members?.length || 0,
      lastUpdated: now.toISOString()
    });

  } catch (error) {
    console.error('Error in member-org-type-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
