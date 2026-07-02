import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

const ACHIEVEMENTS = [
  { id: 'first_donation', label: 'First Donation', description: 'Received your first donation', icon: 'heart', check: (s) => s.donationCount >= 1 },
  { id: 'five_donors', label: '5 Supporters', description: 'Received donations from 5 people', icon: 'users', check: (s) => s.donationCount >= 5 },
  { id: 'ten_donors', label: '10 Supporters', description: 'Reached 10 donations', icon: 'users', check: (s) => s.donationCount >= 10 },
  { id: 'twentyfive_donors', label: '25 Supporters', description: 'Reached 25 donations', icon: 'star', check: (s) => s.donationCount >= 25 },
  { id: 'quarter_goal', label: '25% There', description: 'Reached 25% of your goal', icon: 'target', check: (s) => s.goalPercent >= 25 },
  { id: 'half_goal', label: 'Halfway', description: 'Reached 50% of your goal', icon: 'target', check: (s) => s.goalPercent >= 50 },
  { id: 'threequarter_goal', label: '75% There', description: 'Reached 75% of your goal', icon: 'target', check: (s) => s.goalPercent >= 75 },
  { id: 'full_goal', label: 'Goal Reached', description: 'Reached 100% of your goal', icon: 'trophy', check: (s) => s.goalPercent >= 100 },
  { id: 'hot_streak', label: 'Hot Streak', description: 'Received donations on 3+ consecutive days', icon: 'flame', check: (s) => s.maxStreak >= 3 },
  { id: 'big_day', label: 'Big Day', description: '3+ donations in a single day', icon: 'zap', check: (s) => s.maxDailyDonations >= 3 },
];

function calculateStreak(donations) {
  if (!donations || donations.length === 0) return { maxStreak: 0, maxDailyDonations: 0 };

  const daySet = new Set();
  const dayCounts = {};

  donations.forEach(d => {
    const day = new Date(d.created_at).toISOString().slice(0, 10);
    daySet.add(day);
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  });

  const maxDailyDonations = Math.max(...Object.values(dayCounts), 0);

  const sortedDays = [...daySet].sort();
  let maxStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < sortedDays.length; i++) {
    const prev = new Date(sortedDays[i - 1]);
    const curr = new Date(sortedDays[i]);
    const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);

    if (diffDays === 1) {
      currentStreak++;
      maxStreak = Math.max(maxStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }

  return { maxStreak: sortedDays.length > 0 ? maxStreak : 0, maxDailyDonations };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { campaign_id, team_member_id, session_token } = req.query;
    if (!session_token) {
      return res.status(400).json({ error: 'Session token is required' });
    }
    if (!campaign_id || !team_member_id) {
      return res.status(400).json({ error: 'campaign_id and team_member_id are required' });
    }

    const { data: tokenRecord } = await supabase
      .from('fundraising_login_token')
      .select('email, expires_at')
      .eq('token', session_token)
      .eq('tenant_id', tenant.id)
      .eq('type', 'session')
      .single();

    if (!tokenRecord || new Date(tokenRecord.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { data: requestedMember } = await supabase
      .from('fundraising_team_member')
      .select('id, email')
      .eq('id', team_member_id)
      .eq('campaign_id', campaign_id)
      .eq('tenant_id', tenant.id)
      .single();

    if (!requestedMember || requestedMember.email.toLowerCase() !== tokenRecord.email.toLowerCase()) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { data: allMembers } = await supabase
      .from('fundraising_team_member')
      .select('id, first_name, last_name, email, individual_goal')
      .eq('campaign_id', campaign_id)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true);

    if (!allMembers || allMembers.length === 0) {
      return res.json({ rank: null, total: 0, percentile: null, achievements: [], nearby: [], trend: null });
    }

    const memberIds = allMembers.map(m => m.id);
    const { data: allDonations } = await supabase
      .from('fundraising_donation')
      .select('id, team_member_id, amount, created_at')
      .eq('tenant_id', tenant.id)
      .eq('campaign_id', campaign_id)
      .eq('payment_status', 'succeeded')
      .order('created_at', { ascending: false });

    const statsByMember = {};
    memberIds.forEach(id => {
      statsByMember[id] = { raised: 0, count: 0, donations: [] };
    });

    (allDonations || []).forEach(d => {
      if (statsByMember[d.team_member_id]) {
        statsByMember[d.team_member_id].raised += parseFloat(d.amount || 0);
        statsByMember[d.team_member_id].count += 1;
        statsByMember[d.team_member_id].donations.push(d);
      }
    });

    const leaderboard = allMembers.map(m => ({
      id: m.id,
      name: `${m.first_name} ${m.last_name?.[0] || ''}.`,
      raised: statsByMember[m.id]?.raised || 0,
      count: statsByMember[m.id]?.count || 0,
    })).sort((a, b) => b.raised - a.raised);

    const myIndex = leaderboard.findIndex(m => m.id === team_member_id);
    const rank = myIndex >= 0 ? myIndex + 1 : null;
    const total = leaderboard.length;
    const percentile = rank && total > 1 ? Math.round(((total - rank) / (total - 1)) * 100) : (rank === 1 ? 100 : null);

    const nearby = [];
    if (myIndex >= 0) {
      const start = Math.max(0, myIndex - 2);
      const end = Math.min(leaderboard.length, myIndex + 3);
      for (let i = start; i < end; i++) {
        nearby.push({
          rank: i + 1,
          name: leaderboard[i].name,
          raised: leaderboard[i].raised,
          count: leaderboard[i].count,
          isYou: leaderboard[i].id === team_member_id,
        });
      }
    }

    const myStats = statsByMember[team_member_id] || { raised: 0, count: 0, donations: [] };
    const myMember = allMembers.find(m => m.id === team_member_id);
    const individualGoal = parseFloat(myMember?.individual_goal || 0);
    const goalPercent = individualGoal > 0 ? (myStats.raised / individualGoal) * 100 : 0;

    const { maxStreak, maxDailyDonations } = calculateStreak(myStats.donations);

    const achievementInput = {
      donationCount: myStats.count,
      raised: myStats.raised,
      goalPercent,
      maxStreak,
      maxDailyDonations,
    };

    const achievements = ACHIEVEMENTS.map(a => ({
      id: a.id,
      label: a.label,
      description: a.description,
      icon: a.icon,
      earned: a.check(achievementInput),
    }));

    const now = new Date();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000);

    const recentDonations = (allDonations || []).filter(d => new Date(d.created_at) >= oneDayAgo);
    const olderDonations = (allDonations || []).filter(d => {
      const dt = new Date(d.created_at);
      return dt >= twoDaysAgo && dt < oneDayAgo;
    });

    const recentByMember = {};
    const olderByMember = {};
    memberIds.forEach(id => { recentByMember[id] = 0; olderByMember[id] = 0; });

    recentDonations.forEach(d => {
      if (recentByMember[d.team_member_id] !== undefined) {
        recentByMember[d.team_member_id] += parseFloat(d.amount || 0);
      }
    });
    olderDonations.forEach(d => {
      if (olderByMember[d.team_member_id] !== undefined) {
        olderByMember[d.team_member_id] += parseFloat(d.amount || 0);
      }
    });

    const recentLeaderboard = Object.entries(recentByMember)
      .sort(([, a], [, b]) => b - a);
    const myRecentIndex = recentLeaderboard.findIndex(([id]) => id === team_member_id);
    const recentRank = myRecentIndex >= 0 ? myRecentIndex + 1 : null;

    const myRecent = recentByMember[team_member_id] || 0;
    const myOlder = olderByMember[team_member_id] || 0;
    let trendDirection = 'stable';
    if (myRecent > myOlder) trendDirection = 'up';
    else if (myRecent < myOlder && myOlder > 0) trendDirection = 'down';

    const recentDonationsCount = myStats.donations.filter(d => new Date(d.created_at) >= oneDayAgo).length;

    const milestoneLabels = [];
    if (rank === 1) milestoneLabels.push('top-1');
    else if (rank <= 3) milestoneLabels.push('top-3');
    else if (rank <= 10) milestoneLabels.push('top-10');
    else if (rank <= 50) milestoneLabels.push('top-50');

    if (percentile !== null) {
      if (percentile >= 95) milestoneLabels.push('top-5-percent');
      else if (percentile >= 90) milestoneLabels.push('top-10-percent');
    }

    return res.json({
      rank,
      total,
      percentile,
      milestones: milestoneLabels,
      trend: {
        direction: trendDirection,
        recentRank,
        recentAmount: myRecent,
        recentDonations: recentDonationsCount,
      },
      achievements,
      nearby,
      myStats: {
        raised: myStats.raised,
        donationCount: myStats.count,
        goalPercent: Math.round(goalPercent),
      },
    });
  } catch (err) {
    console.error('[Gamification] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
