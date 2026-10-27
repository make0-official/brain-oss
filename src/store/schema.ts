import type Database from "better-sqlite3";

/**
 * Mirrors cloud `user_memories`, `user_memory_versions`, `memory_edges`
 * minus user/project/brain scoping, so port is a straight column copy.
 * Each entry runs once, in order; `PRAGMA user_version` tracks progress.
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
