#!/usr/bin/env node
const { fileURLToPath } = require("url");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: true });

const { createClient } = require("@supabase/supabase-js");
const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

function extractEntities(text) {
  const entities = [];
  const seen = new Set();
  const properNouns = text.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g);
  if (properNouns) {
    for (const noun of properNouns) {
      const norm = noun.toLowerCase().trim();
      if (!seen.has(norm) && noun.length > 3) {
        entities.push({ name: noun, type: "concept", normalized: norm });
        seen.add(norm);
      }
    }
  }
  return entities;
}

async function findOrCreate(name, entityType, normalized) {
  const { data: existing } = await client
    .from("entities")
    .select("*")
    .eq("normalized_name", normalized)
    .limit(1)
    .maybeSingle();

  if (existing) {
    await client
      .from("entities")
      .update({
        last_seen: new Date().toISOString(),
        mention_count: existing.mention_count + 1,
      })
      .eq("id", existing.id);
    return existing;
  }

  const { data: newEnt, error } = await client
    .from("entities")
    .insert({
      entity_type: entityType,
      name,
      normalized_name: normalized,
      mention_count: 1,
    })
    .select()
    .single();

  if (error) return null;
  return newEnt;
}

async function run() {
  const { data: memories, error } = await client
    .from("memories")
    .select("id, content, summary")
    .order("id", { ascending: true });

  if (error) {
    console.error("fetch error:", error.message);
    return;
  }

  console.log("Processing", memories.length, "memories");
  let totalMentions = 0;

  for (let i = 0; i < memories.length; i++) {
    const m = memories[i];
    const combined = (m.summary || "") + " " + (m.content || "");
    const extracted = extractEntities(combined);

    for (const { name, type, normalized } of extracted) {
      const entity = await findOrCreate(name, type, normalized);
      if (entity) {
        const firstPos = combined.toLowerCase().indexOf(normalized);
        const salience = firstPos < 100 ? 0.8 : firstPos < 300 ? 0.6 : 0.4;
        await client.from("entity_mentions").upsert(
          {
            entity_id: entity.id,
            memory_id: m.id,
            context: (m.summary || "").slice(0, 200),
            salience,
          },
          { onConflict: "entity_id,memory_id" }
        );
        totalMentions++;
      }
    }

    if ((i + 1) % 50 === 0)
      console.log("Progress:", i + 1, "/", memories.length);
  }

  console.log("\nDone. Total entity mentions:", totalMentions);

  const { count: entityCount } = await client
    .from("entities")
    .select("*", { count: "exact", head: true });
  const { count: mentionCount } = await client
    .from("entity_mentions")
    .select("*", { count: "exact", head: true });
  console.log("Unique entities:", entityCount, "Total mentions:", mentionCount);

  const { data: top } = await client
    .from("entities")
    .select("name, entity_type, mention_count")
    .order("mention_count", { ascending: false })
    .limit(15);
  console.log("\nTop entities:");
  for (const e of top)
    console.log(" ", e.mention_count, "x", e.name, "(" + e.entity_type + ")");
}

run().catch((e) => console.error(e.message));
