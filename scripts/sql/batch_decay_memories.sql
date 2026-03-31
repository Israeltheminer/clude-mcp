-- batch_decay_memories: apply type-specific daily decay to memory importance scores
--
-- Run this in the Supabase SQL editor to enable the decay_memories tool and
-- the internal MCP scheduler's nightly decay job.
--
-- Parameters:
--   decay_type  — memory type to target ('episodic', 'semantic', 'procedural', 'self_model')
--   decay_rate  — multiplier per cycle (e.g. 0.93 for episodic = 7%/day decay)
--   min_decay   — floor value; decay_factor never drops below this (default 0.05)
--   cutoff      — only decay memories created before this timestamp (typically NOW() - 24h)
--
-- Returns: count of memories whose decay_factor was updated

CREATE OR REPLACE FUNCTION public.batch_decay_memories(
  decay_type  TEXT,
  decay_rate  FLOAT8,
  min_decay   FLOAT8,
  cutoff      TIMESTAMPTZ
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE memories
  SET
    decay_factor = GREATEST(decay_factor * decay_rate, min_decay),
    importance   = GREATEST(importance   * decay_rate, min_decay)
  WHERE
    memory_type  = decay_type
    AND created_at < cutoff
    AND decay_factor > min_decay;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;
