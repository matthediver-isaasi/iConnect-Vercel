import { supabase } from '../_lib/database.js';
import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenant_id = tenantUser.tenant_id;

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const { limit = 50, offset = 0, task_name } = req.query;

    let query = supabase
      .from('scheduled_task_log')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenant_id)
      .order('executed_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (task_name) {
      query = query.eq('task_name', task_name);
    }

    const { data: logs, error, count } = await query;

    if (error) {
      if (error.code === '42P01') {
        return res.status(200).json({ 
          logs: [], 
          total: 0,
          schedule: getScheduleInfo()
        });
      }
      console.error('[admin/scheduled-task-logs] Error fetching logs:', error);
      return res.status(500).json({ error: 'Failed to fetch scheduled task logs' });
    }

    return res.status(200).json({
      logs: logs || [],
      total: count || 0,
      schedule: getScheduleInfo()
    });

  } catch (error) {
    console.error('[admin/scheduled-task-logs] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function getScheduleInfo() {
  return [
    {
      task_name: 'contract_reminders',
      display_name: 'Contract Reminders',
      description: 'Sends reminder emails to signers who have not yet signed their contracts',
      schedule: 'Every hour',
      schedule_cron: '0 * * * *'
    },
    {
      task_name: 'contract_timeout_notifications',
      display_name: 'Contract Timeout Notifications',
      description: 'Sends notifications to applicants when their contracts expire without signature',
      schedule: 'Every hour',
      schedule_cron: '0 * * * *'
    }
  ];
}
