import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import {
  startOfWeek, endOfWeek, subWeeks,
  startOfDay, endOfDay,
  format, parseISO, differenceInCalendarDays,
  subDays,
} from 'date-fns';

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
    const { weekOffset = '0', startDate, endDate } = req.query;

    let periodStart;
    let periodEnd;

    const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
    const hasStart = typeof startDate === 'string' && startDate.length > 0;
    const hasEnd = typeof endDate === 'string' && endDate.length > 0;

    if (hasStart !== hasEnd) {
      return res.status(400).json({ error: 'Both startDate and endDate must be provided together' });
    }

    const hasCustomRange = hasStart && hasEnd;
    if (hasCustomRange && (!isoDateRe.test(startDate) || !isoDateRe.test(endDate))) {
      return res.status(400).json({ error: 'startDate and endDate must be in yyyy-MM-dd format' });
    }

    if (hasCustomRange) {
      const parsedStart = parseISO(startDate);
      const parsedEnd = parseISO(endDate);
      if (Number.isNaN(parsedStart.getTime()) || Number.isNaN(parsedEnd.getTime())) {
        return res.status(400).json({ error: 'Invalid startDate or endDate' });
      }
      if (parsedStart > parsedEnd) {
        return res.status(400).json({ error: 'startDate must be on or before endDate' });
      }
      periodStart = startOfDay(parsedStart);
      periodEnd = endOfDay(parsedEnd);
    } else {
      const offset = parseInt(weekOffset, 10) || 0;
      const now = new Date();
      const targetDate = offset > 0 ? subWeeks(now, offset) : now;
      periodStart = startOfWeek(targetDate, { weekStartsOn: 1 });
      periodEnd = endOfWeek(targetDate, { weekStartsOn: 1 });
    }

    const periodLengthDays = differenceInCalendarDays(periodEnd, periodStart) + 1;
    const prevPeriodEnd = endOfDay(subDays(periodStart, 1));
    const prevPeriodStart = startOfDay(subDays(periodStart, periodLengthDays));

    const members = [];
    const memberBatchSize = 1000;
    let memberFrom = 0;
    while (true) {
      const { data: memberBatch, error: membersError } = await supabase
        .from('member')
        .select('id, first_name, last_name, email, organization_id, last_activity, login_enabled, profile_photo_url')
        .eq('tenant_id', tenantId)
        .not('organization_id', 'is', null)
        .not('email', 'ilike', 'deleted_%@deleted.local')
        .order('id')
        .range(memberFrom, memberFrom + memberBatchSize - 1);

      if (membersError) {
        console.error('[Engagement Report] Error fetching members:', membersError);
        return res.status(500).json({ error: 'Failed to fetch members' });
      }

      const batch = memberBatch || [];
      members.push(...batch);
      if (batch.length < memberBatchSize) break;
      memberFrom += memberBatchSize;
    }

    const orgIds = [...new Set((members || []).map(m => m.organization_id).filter(Boolean))];

    let organizations = {};
    if (orgIds.length > 0) {
      const batchSize = 100;
      for (let i = 0; i < orgIds.length; i += batchSize) {
        const batch = orgIds.slice(i, i + batchSize);
        const { data: orgs, error: orgsError } = await supabase
          .from('organization')
          .select('id, name')
          .in('id', batch);

        if (!orgsError && orgs) {
          for (const org of orgs) {
            organizations[org.id] = org.name;
          }
        }
      }
    }

    const orgMap = new Map();

    for (const member of (members || [])) {
      const orgId = member.organization_id;
      if (!orgId) continue;

      if (!orgMap.has(orgId)) {
        orgMap.set(orgId, {
          organizationId: orgId,
          organizationName: organizations[orgId] || 'Unknown Organisation',
          totalMembers: 0,
          activeMembers: 0,
          prevActiveMembers: 0,
          members: [],
        });
      }

      const orgData = orgMap.get(orgId);
      orgData.totalMembers++;

      const lastActivity = member.last_activity ? new Date(member.last_activity) : null;
      const isActiveThisPeriod = lastActivity && lastActivity >= periodStart && lastActivity <= periodEnd;
      const isActivePrevPeriod = lastActivity && lastActivity >= prevPeriodStart && lastActivity <= prevPeriodEnd;

      if (isActiveThisPeriod) {
        orgData.activeMembers++;
      }
      if (isActivePrevPeriod) {
        orgData.prevActiveMembers++;
      }

      orgData.members.push({
        id: member.id,
        name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown',
        email: member.email,
        profilePhoto: member.profile_photo_url,
        lastActivity: member.last_activity,
        isActiveThisWeek: isActiveThisPeriod,
        isActiveThisPeriod,
        loginEnabled: member.login_enabled !== false,
      });
    }

    const orgList = Array.from(orgMap.values()).map(org => {
      const engagementRate = org.totalMembers > 0
        ? Math.round((org.activeMembers / org.totalMembers) * 100)
        : 0;

      let trend = 'stable';
      if (org.activeMembers > org.prevActiveMembers) trend = 'up';
      else if (org.activeMembers < org.prevActiveMembers) trend = 'down';

      const trendDiff = org.activeMembers - org.prevActiveMembers;

      org.members.sort((a, b) => {
        if (a.isActiveThisPeriod && !b.isActiveThisPeriod) return -1;
        if (!a.isActiveThisPeriod && b.isActiveThisPeriod) return 1;
        const aDate = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
        const bDate = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
        return bDate - aDate;
      });

      return {
        ...org,
        engagementRate,
        trend,
        trendDiff,
      };
    });

    orgList.sort((a, b) => {
      if (b.activeMembers !== a.activeMembers) return b.activeMembers - a.activeMembers;
      return b.engagementRate - a.engagementRate;
    });

    orgList.forEach((org, idx) => {
      org.rank = idx + 1;
    });

    const totalOrgsWithActivity = orgList.filter(o => o.activeMembers > 0).length;
    const totalActiveMembers = orgList.reduce((sum, o) => sum + o.activeMembers, 0);
    const totalMembers = orgList.reduce((sum, o) => sum + o.totalMembers, 0);
    const overallEngagementRate = totalMembers > 0
      ? Math.round((totalActiveMembers / totalMembers) * 100)
      : 0;
    const topOrg = orgList.length > 0 && orgList[0].activeMembers > 0
      ? orgList[0].organizationName
      : null;

    const periodPayload = {
      start: format(periodStart, 'yyyy-MM-dd'),
      end: format(periodEnd, 'yyyy-MM-dd'),
      label: `${format(periodStart, 'dd MMM yyyy')} - ${format(periodEnd, 'dd MMM yyyy')}`,
    };

    return res.status(200).json({
      organizations: orgList,
      summary: {
        totalOrganizations: orgList.length,
        totalOrgsWithActivity,
        totalActiveMembers,
        totalMembers,
        overallEngagementRate,
        topOrganization: topOrg,
      },
      period: {
        ...periodPayload,
        previousStart: format(prevPeriodStart, 'yyyy-MM-dd'),
        previousEnd: format(prevPeriodEnd, 'yyyy-MM-dd'),
      },
      week: {
        ...periodPayload,
        offset: hasCustomRange ? null : (parseInt(weekOffset, 10) || 0),
      },
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Engagement Report] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch engagement report' });
  }
}
