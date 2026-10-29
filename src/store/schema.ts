import type Database from "better-sqlite3";

/**
 * Mirrors cloud `user_memories`, `user_memory_versions`, `memory_edges`,
 * plus a local `brains` table. `memories.brain_id` is appended so older
 * binaries still read rows they already know. Each entry runs once, in
 * order; `PRAGMA user_version` tracks progress.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'profile')),
    entity_type TEXT NOT NULL DEFAULT 'topic' CHECK (entity_type IN
      ('project', 'artifact', 'source', 'workflow', 'preference', 'correction', 'topic', 'person')),
    confidence INTEGER NOT NULL DEFAULT 75,
    source_type TEXT NOT NULL DEFAULT 'manual',
    is_manually_added INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    embedding BLOB,
    embedding_model TEXT,
    origin_provider TEXT NOT NULL DEFAULT 'make0',
    last_written_via TEXT NOT NULL DEFAULT 'make0',
    deleted_at TEXT,
    deleted_via TEXT,
    discovered_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX memories_deleted_at_idx ON memories (deleted_at);

  CREATE TABLE memory_versions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    confidence INTEGER NOT NULL DEFAULT 75,
    written_by TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX memory_versions_memory_version_uidx ON memory_versions (memory_id, version_number);
  CREATE UNIQUE INDEX memory_versions_one_current_uidx ON memory_versions (memory_id) WHERE is_current = 1;

  CREATE TABLE memory_edges (
    id TEXT PRIMARY KEY,
    from_memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    to_memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL DEFAULT 'related_to',
    weight REAL NOT NULL DEFAULT 0.5,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX memory_edges_pair_uidx ON memory_edges (from_memory_id, to_memory_id, relationship_type);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE memory_versions ADD COLUMN embedding_model TEXT;
  UPDATE memory_versions
  SET embedding_model = (
    SELECT embedding_model FROM memories WHERE memories.id = memory_versions.memory_id
  )
  WHERE is_current = 1 AND embedding_model IS NULL;
  `,
  `ALTER TABLE memory_versions ADD COLUMN writer_name TEXT;`,
  `
  CREATE TABLE brains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT,
    description TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('personal', 'custom')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO brains (id, name, emoji, description, kind, created_at, updated_at)
  VALUES (
    'personal',
    'Personal brain',
    NULL,
    NULL,
    'personal',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

  -- SQLite cannot ADD a REFERENCES column that is NOT NULL with a default.
  ALTER TABLE memories ADD COLUMN brain_id TEXT NOT NULL DEFAULT 'personal';
  CREATE INDEX memories_brain_id_idx ON memories (brain_id);

  CREATE TABLE agent_grants (
    client_id TEXT NOT NULL,
    brain_id TEXT NOT NULL REFERENCES brains (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (client_id, brain_id)
  );
  `,
  `
  CREATE TABLE usage_daily (
    client_id TEXT NOT NULL,
    brain_id TEXT NOT NULL REFERENCES brains (id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    reads INTEGER NOT NULL DEFAULT 0,
    writes INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (client_id, brain_id, day)
  );
  CREATE INDEX usage_daily_day_idx ON usage_daily (day);
  `,
  `
  CREATE TABLE mcp_clients (
    id TEXT PRIMARY KEY,
    name TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  `,
  `
  -- A row means the client's grants were set on purpose, so no grants means no brains.
  CREATE TABLE agent_access (
    client_id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL
  );
  INSERT INTO agent_access (client_id, updated_at)
    SELECT client_id, MAX(created_at) FROM agent_grants GROUP BY client_id;
  `,
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[index]);
      db.pragma(`user_version = ${index + 1}`);
    })();
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
