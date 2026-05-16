import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || "",
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY || ""
);

async function check() {
  const { data: sops, error } = await supabase.from('sop_documents').select('id, title, doc_type, version');
  if (error) {
    console.error('Error:', error.message);
    return;
  }
  console.log('SOP Documents Count:', sops.length);
  console.log('Sample Documents:', sops.slice(0, 5));
}
check();
