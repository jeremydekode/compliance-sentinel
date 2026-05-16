import { supabase } from "../src/integrations/supabase/client";

async function clear() {
  console.log("Cleaning up workspace...");
  
  // Delete all data from tables
  const tables = [
    "chat_messages",
    "sop_impacts",
    "regulatory_changes",
    "analysis_reports",
    "sop_documents"
  ];

  for (const table of tables) {
    console.log(`Clearing ${table}...`);
    const { error } = await supabase.from(table).delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (error) console.error(`Error clearing ${table}:`, error.message);
  }

  console.log("Cleanup complete. Ready for actual analysis.");
}

clear();
