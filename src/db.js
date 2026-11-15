// SQLite storage (Node's built-in node:sqlite, so there are no native deps to compile).
// The schema is plain SQL and maps 1:1 to Postgres if/when we move (see README).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  owner_id TEXT NOT NULL REFERENCES users(id),
  current_version_id TEXT,
  approval_rule TEXT NOT NULL DEFAULT 'all',   -- 'all' = every other member approves; 'owner' = owner approval is enough
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','commenter','viewer')),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at TEXT
);
CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'draft',          -- draft | feedback | reference | status | decision | transcript
  about_id TEXT,                               -- feedback: the version or contribution it is about
  replaces_id TEXT,                            -- the earlier contribution this one replaces, if any
  visibility TEXT NOT NULL CHECK (visibility IN ('private','shared')),
  via TEXT NOT NULL,                           -- 'hand' or the AI label, e.g. 'Claude', 'ChatGPT', 'Qwen3 via LibreChat'
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL REFERENCES users(id),
  via TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'edit',         -- edit | merge | counter | restore | add | update
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','replaced','withdrawn')),
  base_version_id TEXT,                        -- the current version when this was proposed
  counter_to_id TEXT,                          -- proposal this answers, if a counter-proposal
  restored_from_id TEXT,
  add_contribution_id TEXT,                    -- origin 'add': the contribution being added, so the proposal can be redone on a newer version
  add_section TEXT,                            -- origin 'add': the heading it goes under (null = end of document)
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (project_id, number)
);
CREATE TABLE IF NOT EXISTS version_sources (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  contribution_id TEXT NOT NULL REFERENCES contributions(id),
  PRIMARY KEY (version_id, contribution_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','request_changes')),
  comment_id TEXT,
  via TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,                     -- a contribution (c_...) or version (v_...) id
  parent_id TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  quote TEXT,                                  -- the passage being commented on, if any
  via TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS next_steps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  via TEXT NOT NULL,
  activity_mark INTEGER NOT NULL DEFAULT 0,    -- newest activity row when these were written; later rows mean they are out of date
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  via TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  params TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_label TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ai_label TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contrib_project ON contributions(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, number);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, id);
CREATE INDEX IF NOT EXISTS idx_reviews_version ON reviews(version_id, created_at);
`);

// Upgrades for databases created before a column or value existed.
{
  const cols = db.prepare('PRAGMA table_info(contributions)').all().map((c) => c.name);
  if (!cols.includes('about_id')) db.exec('ALTER TABLE contributions ADD COLUMN about_id TEXT');
  if (!cols.includes('replaces_id')) db.exec('ALTER TABLE contributions ADD COLUMN replaces_id TEXT');
  db.exec("UPDATE contributions SET kind = 'reference' WHERE kind = 'note'");
  const vcols = db.prepare('PRAGMA table_info(versions)').all().map((c) => c.name);
  if (!vcols.includes('add_contribution_id')) db.exec('ALTER TABLE versions ADD COLUMN add_contribution_id TEXT');
  if (!vcols.includes('add_section')) db.exec('ALTER TABLE versions ADD COLUMN add_section TEXT');   // "note" became "reference"
}

export const now = () => new Date().toISOString();
export const id = (prefix, bytes = 6) => `${prefix}_${randomBytes(bytes).toString('base64url')}`;
export const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const one = (sql, ...params) => db.prepare(sql).get(...params);
export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
