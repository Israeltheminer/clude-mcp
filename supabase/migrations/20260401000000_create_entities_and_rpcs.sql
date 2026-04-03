-- Entity knowledge graph tables
-- Required by clude-bot SDK (memory-graph.js) but missing from shipped schema

CREATE TABLE IF NOT EXISTS entities (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL DEFAULT 'concept',
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  description TEXT,
  metadata JSONB DEFAULT '{}',
  mention_count INTEGER DEFAULT 0,
  last_seen TIMESTAMPTZ DEFAULT NOW(),
  embedding vector(1024),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_normalized_name ON entities(normalized_name);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_mentions ON entities(mention_count DESC);
CREATE INDEX IF NOT EXISTS idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id BIGSERIAL PRIMARY KEY,
  entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  memory_id BIGINT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  context TEXT DEFAULT '',
  salience REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(entity_id, memory_id)
);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_memory ON entity_mentions(memory_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_salience ON entity_mentions(salience DESC);

CREATE TABLE IF NOT EXISTS entity_relations (
  id BIGSERIAL PRIMARY KEY,
  source_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL DEFAULT 'co_mentioned',
  strength REAL DEFAULT 0.5,
  evidence_memory_ids BIGINT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(source_entity_id, target_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_entity_id);

-- Batch access boost: increment access_count, refresh last_accessed, decay boost
CREATE OR REPLACE FUNCTION batch_boost_memory_access(memory_ids BIGINT[])
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE memories
  SET access_count = access_count + 1,
      last_accessed = NOW(),
      decay_factor = LEAST(1.0, decay_factor + 0.02)
  WHERE id = ANY(memory_ids);
END;
$$;

-- Importance reinforcement: memories retrieved often become more important
CREATE OR REPLACE FUNCTION boost_memory_importance(
  memory_id BIGINT,
  boost_amount FLOAT DEFAULT 0.02,
  max_importance FLOAT DEFAULT 1.0
)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE memories
  SET importance = LEAST(max_importance, importance + boost_amount)
  WHERE id = memory_id;
END;
$$;

-- Vector search across entity embeddings
CREATE OR REPLACE FUNCTION match_entities(
  query_embedding vector(1024),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10,
  filter_types TEXT[] DEFAULT NULL
)
RETURNS TABLE (id BIGINT, similarity FLOAT)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT e.id, (1 - (e.embedding <=> query_embedding))::FLOAT AS similarity
  FROM entities e
  WHERE e.embedding IS NOT NULL
    AND (filter_types IS NULL OR e.entity_type = ANY(filter_types))
    AND (1 - (e.embedding <=> query_embedding)) > match_threshold
  ORDER BY e.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Entity co-occurrence: find entities that share memories with a given entity
CREATE OR REPLACE FUNCTION get_entity_cooccurrence(
  p_entity_id BIGINT,
  min_cooccurrence INT DEFAULT 2,
  max_results INT DEFAULT 10
)
RETURNS TABLE (
  entity_id BIGINT,
  entity_name TEXT,
  entity_type TEXT,
  cooccurrence_count BIGINT
)
LANGUAGE sql AS $$
  SELECT
    em2.entity_id,
    e2.name AS entity_name,
    e2.entity_type,
    COUNT(*)::BIGINT AS cooccurrence_count
  FROM entity_mentions em1
  JOIN entity_mentions em2 ON em1.memory_id = em2.memory_id AND em1.entity_id != em2.entity_id
  JOIN entities e2 ON e2.id = em2.entity_id
  WHERE em1.entity_id = p_entity_id
  GROUP BY em2.entity_id, e2.name, e2.entity_type
  HAVING COUNT(*) >= min_cooccurrence
  ORDER BY cooccurrence_count DESC
  LIMIT max_results;
$$;

-- Also create exec_sql for future auto-migrations
CREATE OR REPLACE FUNCTION exec_sql(query TEXT)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  EXECUTE query;
END;
$$;
