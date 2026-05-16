import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || "",
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY || ""
);

async function check() {
  const { data, error } = await supabase.from('sop_documents').select('id, title').is('embedding', null);
  if (error) {
    console.error('Error:', error.message);
    return;
  }
  console.log('SOPs with MISSING embeddings:', data.length);
  if (data.length > 0) {
    console.log('Sample missing:', data.slice(0, 5));
  }
}
check();
