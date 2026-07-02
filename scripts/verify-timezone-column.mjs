import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lvmzliemqnieeoruhkik.supabase.co';
const supabaseKey = process.env.DEST_SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase
    .from('event')
    .select('id, title, timezone')
    .limit(3);
  
  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
  
  console.log('SUCCESS: timezone column is now available');
  console.log('Sample events:', data.map(e => ({ id: e.id.substring(0,8), title: e.title?.substring(0,30), timezone: e.timezone })));
}

main();
