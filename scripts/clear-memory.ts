import dotenv from "dotenv";
dotenv.config({ override: true });
import { createClient } from "@supabase/supabase-js";
import { rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

async function main() {
  console.log("🧹 Clearing local memory cache and state...");
  const cludeMemoryDir = join(homedir(), ".claude", "clude-memory");
  const ingestStateFile = join(homedir(), ".claude", "clude-ingest-state.json");

  try {
    rmSync(cludeMemoryDir, { recursive: true, force: true });
    console.log(`  ✓ Deleted ${cludeMemoryDir}`);
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error(`  x Failed to delete ${cludeMemoryDir}:`, err.message);
  }

  try {
    rmSync(ingestStateFile, { force: true });
    console.log(`  ✓ Deleted ${ingestStateFile}`);
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error(`  x Failed to delete ${ingestStateFile}:`, err.message);
  }

  if (!supabaseUrl || !supabaseKey) {
    console.error("\n❌ Missing SUPABASE_URL or SUPABASE_KEY in .env. Skipping database clear.");
    return;
  }

  console.log("\n🧹 Clearing Supabase memory database...");
  const supabase = createClient(supabaseUrl, supabaseKey);

  let hasErrors = false;

  console.log("  Clearing 'memory_links' table...");
  const { error: e1 } = await supabase.from("memory_links").delete().neq("source_id", -1);
  if (e1) {
    console.error("  x Error clearing memory_links:", e1.message);
    hasErrors = true;
  } else {
    console.log("  ✓ Cleared memory_links");
  }

  console.log("  Clearing 'memories' table...");
  const { error: e2 } = await supabase.from("memories").delete().neq("id", -1);
  if (e2) {
    console.error("  x Error clearing memories:", e2.message);
    hasErrors = true;
  } else {
    console.log("  ✓ Cleared memories");
  }

  if (hasErrors) {
    console.log("\n⚠️  Memory clear completed with errors.");
  } else {
    console.log("\n✨ All memory cleared successfully!");
  }
}

main().catch(console.error);
