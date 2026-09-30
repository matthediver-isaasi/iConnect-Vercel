import { getZoomAccessToken, getTenantIdFromSession } from '../../_lib/zoomClient.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tenantId = await getTenantIdFromSession(req);
  if (!tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Zoom meeting/webinar ID is required' });
  }

  let token;
  try {
    token = await getZoomAccessToken(req);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to get Zoom access token' });
  }

  const type = req.query.type || 'meeting';
  const basePath = type === 'webinar'
    ? `https://api.zoom.us/v2/webinars/${id}`
    : `https://api.zoom.us/v2/meetings/${id}`;

  if (req.method === 'GET') {
    const action = req.query.action;

    if (action === 'detail') {
      try {
        const pollId = req.query.pollId;
        if (!pollId) {
          return res.status(400).json({ error: 'pollId query parameter is required' });
        }

        const response = await fetch(`${basePath}/polls/${pollId}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[ZoomPolls] Get poll detail error:', response.status, errorText);
          return res.status(response.status).json({ error: 'Failed to get poll details', details: errorText });
        }

        const data = await response.json();
        return res.json(data);
      } catch (error) {
        console.error('[ZoomPolls] Get poll detail error:', error);
        return res.status(500).json({ error: error.message || 'Failed to get poll details' });
      }
    }

    if (action === 'results') {
      try {
        const pastPath = type === 'webinar'
          ? `https://api.zoom.us/v2/past_webinars/${id}/polls`
          : `https://api.zoom.us/v2/past_meetings/${id}/polls`;

        const response = await fetch(pastPath, {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error('[ZoomPolls] Get poll results error:', response.status, errorText);
          if (response.status === 404) {
            return res.json({ questions: [] });
          }
          return res.status(response.status).json({ error: 'Failed to get poll results', details: errorText });
        }

        const data = await response.json();
        return res.json(data);
      } catch (error) {
        console.error('[ZoomPolls] Get poll results error:', error);
        return res.status(500).json({ error: error.message || 'Failed to get poll results' });
      }
    }

    try {
      const response = await fetch(`${basePath}/polls`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ZoomPolls] List polls error:', response.status, errorText);
        if (response.status === 404) {
          return res.json({ polls: [] });
        }
        return res.status(response.status).json({ error: 'Failed to list polls', details: errorText });
      }

      const data = await response.json();
      return res.json(data);
    } catch (error) {
      console.error('[ZoomPolls] List polls error:', error);
      return res.status(500).json({ error: error.message || 'Failed to list polls' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { title, anonymous, questions } = req.body;

      if (!title || !questions || questions.length === 0) {
        return res.status(400).json({ error: 'title and questions are required' });
      }

      const pollPayload = {
        title,
        anonymous: anonymous || false,
        questions: questions.map(q => ({
          name: q.name,
          type: q.type || 'single',
          answers: q.answers || []
        }))
      };

      const response = await fetch(`${basePath}/polls`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(pollPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ZoomPolls] Create poll error:', response.status, errorText);
        return res.status(response.status).json({ error: 'Failed to create poll', details: errorText });
      }

      const data = await response.json();
      return res.json(data);
    } catch (error) {
      console.error('[ZoomPolls] Create poll error:', error);
      return res.status(500).json({ error: error.message || 'Failed to create poll' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { pollId, title, anonymous, questions } = req.body;

      if (!pollId) {
        return res.status(400).json({ error: 'pollId is required' });
      }

      if (!title || !questions || !Array.isArray(questions) || questions.length === 0) {
        return res.status(400).json({ error: 'title and questions are required' });
      }

      const pollPayload = {
        title,
        anonymous: anonymous || false,
        questions: questions.map(q => ({
          name: q.name,
          type: q.type || 'single',
          answers: q.answers || []
        }))
      };

      const response = await fetch(`${basePath}/polls/${pollId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(pollPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ZoomPolls] Update poll error:', response.status, errorText);
        return res.status(response.status).json({ error: 'Failed to update poll', details: errorText });
      }

      if (response.status === 204) {
        return res.json({ success: true });
      }

      const data = await response.json();
      return res.json(data);
    } catch (error) {
      console.error('[ZoomPolls] Update poll error:', error);
      return res.status(500).json({ error: error.message || 'Failed to update poll' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { pollId } = req.query;

      if (!pollId) {
        return res.status(400).json({ error: 'pollId query parameter is required' });
      }

      const response = await fetch(`${basePath}/polls/${pollId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok && response.status !== 204) {
        const errorText = await response.text();
        console.error('[ZoomPolls] Delete poll error:', response.status, errorText);
        return res.status(response.status).json({ error: 'Failed to delete poll', details: errorText });
      }

      return res.json({ success: true });
    } catch (error) {
      console.error('[ZoomPolls] Delete poll error:', error);
      return res.status(500).json({ error: error.message || 'Failed to delete poll' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
