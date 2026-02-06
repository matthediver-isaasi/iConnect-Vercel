import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { startOfWeek, endOfWeek, subWeeks, format, parseISO } from 'date-fns';

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
    const { weekOffset = '0' } = req.query;

    const offset = parseInt(weekOffset, 10) || 0;
    const now = new Date();
    const targetDate = offset > 0 ? subWeeks(now, offset) : now;
    const weekStart = startOfWeek(targetDate, { weekStartsOn: 1 });
    const weekEnd = endOfWeek(targetDate, { weekStartsOn: 1 });

    const prevWeekStart = startOfWeek(subWeeks(targetDate, 1), { weekStartsOn: 1 });
    const prevWeekEnd = endOfWeek(subWeeks(targetDate, 1), { weekStartsOn: 1 });

    const { data: members, error: membersError } = await supabase
      .from('member')
      .select('id, first_name, last_name, email, organization_id, last_activity, login_enabled, profile_photo_url')
      .eq('tenant_id', tenantId)
      .not('organization_id', 'is', null);

    if (membersError) {
      console.error('[Engagement Report] Error fetching members:', membersError);
      return res.status(500).json({ error: 'Failed to fetch members' });
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
      const isActiveThisWeek = lastActivity && lastActivity >= weekStart && lastActivity <= weekEnd;
      const isActivePrevWeek = lastActivity && lastActivity >= prevWeekStart && lastActivity <= prevWeekEnd;

      if (isActiveThisWeek) {
        orgData.activeMembers++;
      }
      if (isActivePrevWeek) {
        orgData.prevActiveMembers++;
      }

      orgData.members.push({
        id: member.id,
        name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || 'Unknown',
        email: member.email,
        profilePhoto: member.profile_photo_url,
        lastActivity: member.last_activity,
        isActiveThisWeek,
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
        if (a.isActiveThisWeek && !b.isActiveThisWeek) return -1;
        if (!a.isActiveThisWeek && b.isActiveThisWeek) return 1;
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
      week: {
        start: format(weekStart, 'yyyy-MM-dd'),
        end: format(weekEnd, 'yyyy-MM-dd'),
        offset,
        label: `${format(weekStart, 'dd MMM yyyy')} - ${format(weekEnd, 'dd MMM yyyy')}`,
      },
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Engagement Report] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch engagement report' });
  }
}
