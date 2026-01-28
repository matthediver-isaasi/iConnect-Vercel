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
    const now = new Date();

    const { formId } = req.query;

    let formsQuery = supabase
      .from('form_due_diligence_config')
      .select('form_id, workflow_stages')
      .eq('tenant_id', tenantId)
      .eq('is_active', true);

    if (formId) {
      formsQuery = formsQuery.eq('form_id', formId);
    }

    const { data: ddConfigs, error: configError } = await formsQuery;

    if (configError) {
      console.error('Error fetching DD configs:', configError);
      return res.status(500).json({ error: 'Failed to fetch configuration' });
    }

    const formIds = ddConfigs?.map(c => c.form_id) || [];
    
    if (formIds.length === 0) {
      return res.status(200).json({
        totalVerified: 0,
        averageTurnaroundDays: 0,
        averageTurnaroundHours: 0,
        outstandingVerifications: 0,
        verifiedThisPeriod: {},
        turnaroundBreakdown: [],
        outstandingByAge: [],
        lastUpdated: now.toISOString()
      });
    }

    const canonicalizeKey = (str) => {
      if (!str) return '';
      return str
        .toLowerCase()
        .trim()
        .replace(/[-_\s]+/g, ' ')
        .replace(/\s+/g, ' ');
    };

    const verifiedCanonical = canonicalizeKey('Verified');
    const inReviewCanonical = canonicalizeKey('In Review');
    const newCanonical = canonicalizeKey('New');

    const verifiedStageIds = new Set();
    const preVerifiedStageIds = new Set();

    ddConfigs.forEach(config => {
      const stages = config.workflow_stages || [];
      stages.forEach(stage => {
        const canonical = canonicalizeKey(stage.label);
        if (canonical === verifiedCanonical) {
          verifiedStageIds.add(stage.id);
        }
        if (canonical === inReviewCanonical || canonical === newCanonical) {
          preVerifiedStageIds.add(stage.id);
        }
      });
    });

    const { data: allSubmissions, error: submissionsError } = await supabase
      .from('form_submission')
      .select('id, form_id, workflow_status, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .in('form_id', formIds);

    if (submissionsError) {
      console.error('Error fetching submissions:', submissionsError);
      return res.status(500).json({ error: 'Failed to fetch submissions' });
    }

    const isVerifiedStatus = (status) => {
      if (!status) return false;
      const canonical = canonicalizeKey(status);
      if (canonical === verifiedCanonical) return true;
      return verifiedStageIds.has(status);
    };

    const isPreVerifiedStatus = (status) => {
      if (!status) return true;
      const canonical = canonicalizeKey(status);
      if (canonical === inReviewCanonical || canonical === newCanonical) return true;
      return preVerifiedStageIds.has(status);
    };

    const verifiedSubmissions = allSubmissions?.filter(s => isVerifiedStatus(s.workflow_status)) || [];
    const outstandingSubmissions = allSubmissions?.filter(s => isPreVerifiedStatus(s.workflow_status)) || [];

    const totalVerified = verifiedSubmissions.length;
    const outstandingVerifications = outstandingSubmissions.length;

    let totalTurnaroundMs = 0;
    const turnaroundDaysArray = [];

    verifiedSubmissions.forEach(sub => {
      const created = new Date(sub.created_at);
      const updated = new Date(sub.updated_at);
      const turnaroundMs = updated.getTime() - created.getTime();
      const turnaroundDays = turnaroundMs / (1000 * 60 * 60 * 24);
      totalTurnaroundMs += turnaroundMs;
      turnaroundDaysArray.push(turnaroundDays);
    });

    const averageTurnaroundMs = totalVerified > 0 ? totalTurnaroundMs / totalVerified : 0;
    const averageTurnaroundDays = averageTurnaroundMs / (1000 * 60 * 60 * 24);
    const averageTurnaroundHours = averageTurnaroundMs / (1000 * 60 * 60);

    const turnaroundRanges = [
      { range: '0-2 days', min: 0, max: 2 },
      { range: '3-5 days', min: 3, max: 5 },
      { range: '6-10 days', min: 6, max: 10 },
      { range: '11+ days', min: 11, max: Infinity }
    ];

    const turnaroundBreakdown = turnaroundRanges.map(r => {
      const count = turnaroundDaysArray.filter(d => d >= r.min && d <= r.max).length;
      return {
        range: r.range,
        count,
        percentage: totalVerified > 0 ? Math.round((count / totalVerified) * 100) : 0
      };
    });

    const outstandingAgeArray = outstandingSubmissions.map(sub => {
      const created = new Date(sub.created_at);
      const ageMs = now.getTime() - created.getTime();
      return ageMs / (1000 * 60 * 60 * 24);
    });

    const outstandingByAge = turnaroundRanges.map(r => {
      const count = outstandingAgeArray.filter(d => d >= r.min && d <= r.max).length;
      return {
        range: r.range,
        count,
        percentage: outstandingVerifications > 0 ? Math.round((count / outstandingVerifications) * 100) : 0
      };
    });

    const getPeriodBounds = (periodKey) => {
      const start = new Date(now);
      const prevStart = new Date(now);
      const prevEnd = new Date(now);

      switch (periodKey) {
        case 'week':
          start.setDate(now.getDate() - 7);
          prevStart.setDate(now.getDate() - 14);
          prevEnd.setDate(now.getDate() - 7);
          break;
        case 'month':
          start.setMonth(now.getMonth() - 1);
          prevStart.setMonth(now.getMonth() - 2);
          prevEnd.setMonth(now.getMonth() - 1);
          break;
        case 'quarter':
          start.setMonth(now.getMonth() - 3);
          prevStart.setMonth(now.getMonth() - 6);
          prevEnd.setMonth(now.getMonth() - 3);
          break;
        case 'year':
          start.setFullYear(now.getFullYear() - 1);
          prevStart.setFullYear(now.getFullYear() - 2);
          prevEnd.setFullYear(now.getFullYear() - 1);
          break;
        default:
          return { start: null, prevStart: null, prevEnd: null };
      }

      return { start, prevStart, prevEnd };
    };

    const periods = ['week', 'month', 'quarter', 'year', 'all'];
    const verifiedThisPeriod = {};

    periods.forEach(periodKey => {
      if (periodKey === 'all') {
        verifiedThisPeriod[periodKey] = {
          current: totalVerified,
          previous: null,
          change: null,
          changeDirection: null
        };
        return;
      }

      const { start, prevStart, prevEnd } = getPeriodBounds(periodKey);

      const current = verifiedSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= start && updated <= now;
      }).length;

      const previous = verifiedSubmissions.filter(s => {
        const updated = new Date(s.updated_at);
        return updated >= prevStart && updated < prevEnd;
      }).length;

      const change = previous > 0 ? Math.round(((current - previous) / previous) * 100) : (current > 0 ? 100 : 0);
      const changeDirection = current >= previous ? 'up' : 'down';

      verifiedThisPeriod[periodKey] = {
        current,
        previous,
        change: Math.abs(change),
        changeDirection
      };
    });

    return res.status(200).json({
      totalVerified,
      averageTurnaroundDays: Math.round(averageTurnaroundDays * 10) / 10,
      averageTurnaroundHours: Math.round(averageTurnaroundHours),
      outstandingVerifications,
      verifiedThisPeriod,
      turnaroundBreakdown,
      outstandingByAge,
      lastUpdated: now.toISOString()
    });

  } catch (error) {
    console.error('Error in verification-stats:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
