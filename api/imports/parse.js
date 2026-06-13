import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';
import { parseMultipartForm } from '../_lib/multipart.js';
import { parseImportFile } from '../_lib/importFileParser.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }
  
  const session = await getSession(req);
  if (!session?.data?.memberId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    const { file } = await parseMultipartForm(req);
    
    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { records, fileLabel } = await parseImportFile(file);
    
    if (records.length === 0) {
      return res.status(400).json({ error: `The ${fileLabel} is empty` });
    }
    
    const columns = Object.keys(records[0]);
    
    res.json({
      columns,
      preview: records.slice(0, 5),
      totalRows: records.length
    });
  } catch (error) {
    console.error('[Import Parse] Error:', error);
    res.status(500).json({ error: error.message || 'Failed to parse file' });
  }
}
