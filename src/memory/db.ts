/**
 * OpenCarls — Memoria persistente sobre `bun:sqlite` (WAL + FTS5).
 *
 * Tablas:
 *   - meta              : KV de esquema/runtime.
 *   - sessions          : sesiones del daemon (crash detection).
 *   - episodic_memory   : memoria episódica comprimida (decisiones, hallazgos,
 *                         errores, checkpoints) + índice FTS5 `episodic_memory_fts`.
 *   - hardening_backlog : backlog del bucle Lockpack (fases HARDEN/…).
 *   - skills_registry   : índice de Skills Hermes + FTS5 `skills_fts`.
 *   - tool_calls        : telemetría de herramientas (latencias, errores).
 *
 * Diseño anti-degradación: la memoria episódica es el destino de la
 * compactación de contexto (Fase 3, `src/memory/compactor.ts`), por eso
 * cada fila estima tokens y lleva `importance` para priorizar la retrievability.
 */
import { Database, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../core/config";
import { createLogger } from "../core/logger";

const log = createLogger("memory:db");

export type EpisodeKind =
  | "decision"
  | "finding"
  | "error"
  | "checkpoint"
  | "progress"
  | "skill"
  | "visual" | "compaction";

export type BacklogStatus = "open" | "in_progress" | "done" | "wontfix";
export type BacklogSeverity = "critical" | "high" | "medium" | "low";
export type SkillStatus = "draft" | "active" | "archived";

export interface EpisodeInput {
  session_id?: string | null;
  kind: EpisodeKind;
  title: string;
  summary: string;
  details?: string;
  tags?: string[];
  importance?: number; // 1..10
  source?: string | null;
}

export interface EpisodeRow {
  id: number;
  session_id: string | null;
  kind: EpisodeKind;
  title: string;
  summary: string;
  details: string;
  tags: string;
  importance: number;
  token_estimate: number;
  source: string | null;
  created_at: number;
}

export interface BacklogInput {
  session_id?: string | null;
  title: string;
  description?: string;
  severity?: BacklogSeverity;
  phase?: string | null;
  file_path?: string | null;
}

export interface BacklogRow {
  id: number;
  session_id: string | null;
  title: string;
  description: string;
  severity: BacklogSeverity;
  status: BacklogStatus;
  phase: string | null;
  file_path: string | null;
  resolution_notes: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

export interface SkillRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  triggers: string;
  version: string;
  success_count: number;
  fail_count: number;
  path: string;
  status: SkillStatus;
  source_task: string | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}

const SCHEMA_SQL = `
-- ── Meta ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ── Sesiones del daemon ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  label       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- active|closed|crashed
  cwd         TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  meta        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status);

-- ── Memoria episódica (destino de la compactación de contexto) ────────────
CREATE TABLE IF NOT EXISTS episodic_memory (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  details        TEXT NOT NULL DEFAULT '',
  tags           TEXT NOT NULL DEFAULT '[]',
  importance     INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
  token_estimate INTEGER NOT NULL DEFAULT 0,
  source         TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodic_created  ON episodic_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_kind     ON episodic_memory(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_import   ON episodic_memory(importance DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_session  ON episodic_memory(session_id);

-- ── Backlog de endurecimiento (Lockpack) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS hardening_backlog (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL DEFAULT 'medium',
  status           TEXT NOT NULL DEFAULT 'open',
  phase            TEXT,
  file_path        TEXT,
  resolution_notes TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_backlog_status   ON hardening_backlog(status, severity);
CREATE INDEX IF NOT EXISTS idx_backlog_created  ON hardening_backlog(created_at DESC);

-- ── Registro de Skills (Hermes Skill Forge) ───────────────────────────────
CREATE TABLE IF NOT EXISTS skills_registry (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  triggers      TEXT NOT NULL DEFAULT '[]',
  version       TEXT NOT NULL DEFAULT '0.1.0',
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  path          TEXT NOT NULL,
  status        skill_status_placeholder,
  source_task   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_skills_status ON skills_registry(status, success_count DESC);
CREATE INDEX IF NOT EXISTS idx_skills_slug   ON skills_registry(slug);

-- ── Telemetría de herramientas ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  tool        TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool  ON tool_calls(tool, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_time  ON tool_calls(created_at DESC);

-- ── Tablero de tareas vivas (todo_board, Fase 2) ───────────────────────────
CREATE TABLE IF NOT EXISTS todos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','blocked','done')),
  priority    INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 4),
  tags        TEXT NOT NULL DEFAULT '[]',
  position    INTEGER NOT NULL DEFAULT 1000,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_todos_status  ON todos(status, position, created_at);
CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
`;

const FTS_SQL = `
-- Índice FTS5 externo sobre episodic_memory (content table)
CREATE VIRTUAL TABLE IF NOT EXISTS episodic_memory_fts USING fts5(
  title, summary, details, tags,
  content='episodic_memory', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS episodic_memory_ai AFTER INSERT ON episodic_memory BEGIN
  INSERT INTO episodic_memory_fts(rowid, title, summary, details, tags)
  VALUES (new.id, new.title, new.summary, new.details, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS episodic_memory_ad AFTER DELETE ON episodic_memory BEGIN
  INSERT INTO episodic_memory_fts(episodic_memory_fts, rowid, title, summary, details, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.details, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS episodic_memory_au AFTER UPDATE ON episodic_memory BEGIN
  INSERT INTO episodic_memory_fts(episodic_memory_fts, rowid, title, summary, details, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.details, old.tags);
  INSERT INTO episodic_memory_fts(rowid, title, summary, details, tags)
  VALUES (new.id, new.title, new.summary, new.details, new.tags);
END;

-- Índice FTS5 sobre el registro de skills
CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  slug, name, description, triggers,
  content='skills_registry', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills_registry BEGIN
  INSERT INTO skills_fts(rowid, slug, name, description, triggers)
  VALUES (new.id, new.slug, new.name, new.description, new.triggers);
END;
CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills_registry BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, slug, name, description, triggers)
  VALUES ('delete', old.id, old.slug, old.name, old.description, old.triggers);
END;
CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills_registry BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, slug, name, description, triggers)
  VALUES ('delete', old.id, old.slug, old.name, old.description, old.triggers);
  INSERT INTO skills_fts(rowid, slug, name, description, triggers)
  VALUES (new.id, new.slug, new.name, new.description, new.triggers);
END;
`;

// Definición de columna inyectada en runtime sobre el placeholder del DDL:
const SKILL_STATUS_FIX =
  "TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived'))";

let db: Database | null = null;
let ftsEnabled = false;
const stmtCache = new Map<string, Statement>();

export function getDb(): Database {
  if (db) return db;

  mkdirSync(dirname(CONFIG.db_path), { recursive: true });
  db = new Database(CONFIG.db_path, { create: true });

  // ── PRAGMAS: WAL + tolerancia a concurrencia + rendimiento ──────────────
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA cache_size = -16000;"); // 16 MiB de página-cache
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA mmap_size = 268435456;"); // 256 MiB mmap

  // Esquema base (inyección del CHECK de status de skills)
  db.exec(SCHEMA_SQL.replaceAll("skill_status_placeholder", SKILL_STATUS_FIX));

  // FTS5: si la build de SQLite no lo trae, degradamos a LIKE (sigue funcional)
  try {
    db.exec(FTS_SQL);
    ftsEnabled = true;
  } catch (e) {
    ftsEnabled = false;
    log.warn("FTS5 no disponible; se usará búsqueda LIKE como fallback", {
      err: e instanceof Error ? e.message : String(e),
    });
  }

  // Marca de esquema
  const ver = db
    .query("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;
  if (!ver) {
    db.query(
      "INSERT INTO meta (key, value, updated_at) VALUES ('schema_version', ?, ?)",
    ).run("1", Date.now());
  }

  // Sesiones 'active' huérfanas (crash anterior) → crashed
  db.query(
    "UPDATE sessions SET status = 'crashed', ended_at = ? WHERE status = 'active'",
  ).run(Date.now());

  const integrity = db.query("PRAGMA quick_check").get() as { quick_check: string } | undefined;
  if (integrity && integrity.quick_check !== "ok") {
    log.error("quick_check de SQLite falló", integrity);
  }

  log.info("base de datos abierta", {
    path: CONFIG.db_path,
    fts5: ftsEnabled,
    journal: (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
  });
  return db;
}

export function hasFts(): boolean {
  getDb();
  return ftsEnabled;
}

function prep(sql: string): Statement {
  let s = stmtCache.get(sql);
  if (!s) {
    s = getDb().query(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

function estimateTokens(...parts: string[]): number {
  const chars = parts.reduce((n, p) => n + p.length, 0);
  return Math.ceil(chars / 4);
}

function tagsJson(tags?: string[]): string {
  try {
    return JSON.stringify((tags ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 24));
  } catch {
    return "[]";
  }
}

/** Escape para la sintaxis de FTS5 MATCH (frases entre comillas). */
export function ftsQuery(raw: string): string {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" ");
}

// ══════════════════════════════════════════════════════ SESIONES ══════════

export function openSession(label?: string, cwd?: string): string {
  const id = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  prep(
    `INSERT INTO sessions (id, label, status, cwd, started_at, meta) VALUES (?, ?, 'active', ?, ?, '{}')`,
  ).run(id, label ?? null, cwd ?? process.cwd(), Date.now());
  return id;
}

export function closeSession(id: string, status: "closed" | "crashed" = "closed"): void {
  prep("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?").run(status, Date.now(), id);
}

export interface SessionRow {
  id: string;
  label: string | null;
  status: "active" | "closed" | "crashed";
  cwd: string | null;
  started_at: number;
  ended_at: number | null;
  meta: string;
}

export function listSessions(limit = 50): SessionRow[] {
  return prep(
    "SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?",
  ).all(limit) as unknown as SessionRow[];
}

// ═══════════════════════════════════════════════ MEMORIA EPISÓDICA ════════

export function remember(input: EpisodeInput): number {
  const res = prep(
    `INSERT INTO episodic_memory
      (session_id, kind, title, summary, details, tags, importance, token_estimate, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.session_id ?? null,
    input.kind,
    input.title,
    input.summary,
    input.details ?? "",
    tagsJson(input.tags),
    Math.max(1, Math.min(10, input.importance ?? 5)),
    estimateTokens(input.title, input.summary, input.details ?? ""),
    input.source ?? null,
    Date.now(),
  );
  return Number(res.lastInsertRowid);
}

export function recentEpisodes(limit = 40, kind?: EpisodeKind): EpisodeRow[] {
  if (kind) {
    return prep(
      "SELECT * FROM episodic_memory WHERE kind = ? ORDER BY id DESC LIMIT ?",
    ).all(kind, limit) as unknown as EpisodeRow[];
  }
  return prep("SELECT * FROM episodic_memory ORDER BY id DESC LIMIT ?").all(
    limit,
  ) as unknown as EpisodeRow[];
}

/**
 * Búsqueda en memoria episódica. FTS5 si está disponible; LIKE como fallback
 * (mismos campos, mismo orden por relevancia de importancia + recencia).
 */
export function searchEpisodes(query: string, limit = 20): EpisodeRow[] {
  getDb();
  if (ftsEnabled) {
    try {
      return prep(
        `SELECT e.* FROM episodic_memory_fts f
         JOIN episodic_memory e ON e.id = f.rowid
         WHERE episodic_memory_fts MATCH ?
         ORDER BY rank, e.importance DESC, e.id DESC
         LIMIT ?`,
      ).all(ftsQuery(query), limit) as unknown as EpisodeRow[];
    } catch (e) {
      log.warn("FTS MATCH falló; fallback LIKE", { err: String(e) });
    }
  }
  const like = `%${query.replace(/[%_]/g, " ")}%`;
  return prep(
    `SELECT * FROM episodic_memory
     WHERE title LIKE ? OR summary LIKE ? OR details LIKE ? OR tags LIKE ?
     ORDER BY importance DESC, created_at DESC
     LIMIT ?`,
  ).all(like, like, like, like, limit) as unknown as EpisodeRow[];
}

export function updateEpisode(id: number, patch: Partial<EpisodeInput>): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    args.push(patch.title);
  }
  if (patch.summary !== undefined) {
    sets.push("summary = ?");
    args.push(patch.summary);
  }
  if (patch.details !== undefined) {
    sets.push("details = ?");
    args.push(patch.details);
  }
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    args.push(tagsJson(patch.tags));
  }
  if (patch.importance !== undefined) {
    sets.push("importance = ?");
    args.push(Math.max(1, Math.min(10, patch.importance)));
  }
  if (sets.length === 0) return false;
  args.push(
    estimateTokens(patch.title ?? "", patch.summary ?? "", patch.details ?? ""),
    id,
  );
  const res = prep(
    `UPDATE episodic_memory SET ${sets.join(", ")}, token_estimate = ? WHERE id = ?`,
  ).run(...args);
  return res.changes > 0;
}

/** Compactación física: elimina episodios de baja importancia ya resumidos. */
export function pruneEpisodes(opts: { older_than_ms: number; min_importance?: number }): number {
  const cutoff = Date.now() - opts.older_than_ms;
  const minImp = opts.min_importance ?? 4;
  const res = prep(
    "DELETE FROM episodic_memory WHERE created_at < ? AND importance < ?",
  ).run(cutoff, minImp);
  return res.changes;
}

export function episodicStats(): {
  total: number;
  tokens: number;
  by_kind: Record<string, number>;
} {
  const d = getDb();
  const total = (d.query("SELECT COUNT(*) c FROM episodic_memory").get() as { c: number }).c;
  const tokens = (
    d.query("SELECT COALESCE(SUM(token_estimate),0) t FROM episodic_memory").get() as { t: number }
  ).t;
  const byKind: Record<string, number> = {};
  for (const row of d
    .query("SELECT kind, COUNT(*) c FROM episodic_memory GROUP BY kind")
    .all() as { kind: string; c: number }[]) {
    byKind[row.kind] = row.c;
  }
  return { total, tokens, by_kind: byKind };
}

// ═══════════════════════════════════════════ BACKLOG DE ENDURECIMIENTO ════

export function addBacklogItem(input: BacklogInput): number {
  const now = Date.now();
  const res = prep(
    `INSERT INTO hardening_backlog
      (session_id, title, description, severity, status, phase, file_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(
    input.session_id ?? null,
    input.title,
    input.description ?? "",
    input.severity ?? "medium",
    input.phase ?? null,
    input.file_path ?? null,
    now,
    now,
  );
  return Number(res.lastInsertRowid);
}

export function listBacklog(status?: BacklogStatus, limit = 100): BacklogRow[] {
  if (status) {
    return prep(
      `SELECT * FROM hardening_backlog WHERE status = ?
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
                created_at DESC
       LIMIT ?`,
    ).all(status, limit) as unknown as BacklogRow[];
  }
  return prep("SELECT * FROM hardening_backlog ORDER BY created_at DESC LIMIT ?").all(
    limit,
  ) as unknown as BacklogRow[];
}

export function resolveBacklogItem(
  id: number,
  notes?: string,
  status: BacklogStatus = "done",
): boolean {
  const now = Date.now();
  const res = prep(
    `UPDATE hardening_backlog
     SET status = ?, resolution_notes = ?, updated_at = ?, resolved_at = ?
     WHERE id = ?`,
  ).run(status, notes ?? null, now, status === "done" ? now : null, id);
  return res.changes > 0;
}

export function setBacklogStatus(id: number, status: BacklogStatus): boolean {
  const res = prep("UPDATE hardening_backlog SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    Date.now(),
    id,
  );
  return res.changes > 0;
}

export function backlogStats(): Record<BacklogStatus, number> & { total: number } {
  const out = { open: 0, in_progress: 0, done: 0, wontfix: 0, total: 0 };
  for (const row of getDb()
    .query("SELECT status, COUNT(*) c FROM hardening_backlog GROUP BY status")
    .all() as { status: BacklogStatus; c: number }[]) {
    out[row.status] = row.c;
    out.total += row.c;
  }
  return out;
}

// ═════════════════════════════════════════════════════ SKILLS ═════════════

export function registerSkill(input: {
  slug: string;
  name: string;
  description?: string;
  triggers?: string[];
  version?: string;
  path: string;
  status?: SkillStatus;
  source_task?: string | null;
}): number {
  const now = Date.now();
  const res = prep(
    `INSERT INTO skills_registry
      (slug, name, description, triggers, version, path, status, source_task, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       triggers = excluded.triggers,
       version = excluded.version,
       path = excluded.path,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(
    input.slug,
    input.name,
    input.description ?? "",
    tagsJson(input.triggers),
    input.version ?? "0.1.0",
    input.path,
    input.status ?? "draft",
    input.source_task ?? null,
    now,
    now,
  );
  if (res.changes === 0) {
    const existing = prep("SELECT id FROM skills_registry WHERE slug = ?").get(input.slug) as
      | { id: number }
      | null;
    return existing?.id ?? -1;
  }
  const row = prep("SELECT id FROM skills_registry WHERE slug = ?").get(input.slug) as {
    id: number;
  };
  return row.id;
}

export function getSkill(slug: string): SkillRow | null {
  return (prep("SELECT * FROM skills_registry WHERE slug = ?").get(slug) as SkillRow | null) ?? null;
}

export function listSkills(status?: SkillStatus, limit = 200): SkillRow[] {
  if (status) {
    return prep(
      "SELECT * FROM skills_registry WHERE status = ? ORDER BY success_count DESC LIMIT ?",
    ).all(status, limit) as unknown as SkillRow[];
  }
  return prep("SELECT * FROM skills_registry ORDER BY success_count DESC, id DESC LIMIT ?").all(
    limit,
  ) as unknown as SkillRow[];
}

export function bumpSkillStats(slug: string, ok: boolean): void {
  const now = Date.now();
  if (ok) {
    prep(
      "UPDATE skills_registry SET success_count = success_count + 1, last_used_at = ?, updated_at = ? WHERE slug = ?",
    ).run(now, now, slug);
  } else {
    prep(
      "UPDATE skills_registry SET fail_count = fail_count + 1, last_used_at = ?, updated_at = ? WHERE slug = ?",
    ).run(now, now, slug);
  }
}

export function setSkillStatus(slug: string, status: SkillStatus, bumpVersion?: string): boolean {
  const res = bumpVersion
    ? prep(
        "UPDATE skills_registry SET status = ?, version = ?, updated_at = ? WHERE slug = ?",
      ).run(status, bumpVersion, Date.now(), slug)
    : prep("UPDATE skills_registry SET status = ?, updated_at = ? WHERE slug = ?").run(
        status,
        Date.now(),
        slug,
      );
  return res.changes > 0;
}

export function searchSkills(query: string, limit = 20): SkillRow[] {
  getDb();
  if (ftsEnabled) {
    try {
      return prep(
        `SELECT s.* FROM skills_fts f JOIN skills_registry s ON s.id = f.rowid
         WHERE skills_fts MATCH ? ORDER BY rank, s.success_count DESC LIMIT ?`,
      ).all(ftsQuery(query), limit) as unknown as SkillRow[];
    } catch {
      /* fallback */
    }
  }
  const like = `%${query.replace(/[%_]/g, " ")}%`;
  return prep(
    "SELECT * FROM skills_registry WHERE slug LIKE ? OR name LIKE ? OR description LIKE ? OR triggers LIKE ? ORDER BY success_count DESC LIMIT ?",
  ).all(like, like, like, like, limit) as unknown as SkillRow[];
}

// ════════════════════════════════════════════════ TELEMETRÍA ══════════════

export function recordToolCall(
  tool: string,
  ok: boolean,
  duration_ms: number,
  error?: string,
  session_id?: string | null,
): void {
  try {
    prep(
      `INSERT INTO tool_calls (session_id, tool, ok, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(session_id ?? null, tool, ok ? 1 : 0, Math.round(duration_ms), error ?? null, Date.now());
  } catch (e) {
    log.warn("no se pudo registrar tool_call", { err: String(e) });
  }
}

export function toolStats(limit = 20): Array<{
  tool: string;
  calls: number;
  errors: number;
  avg_ms: number;
}> {
  return getDb()
    .query(
      `SELECT tool, COUNT(*) calls, SUM(1 - ok) errors, CAST(AVG(duration_ms) AS INTEGER) avg_ms
       FROM tool_calls GROUP BY tool ORDER BY calls DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ tool: string; calls: number; errors: number; avg_ms: number }>;
}

// ═════════════════════════════════════════════════ UTILIDADES ═════════════

// ── Todo Board (tareas vivas) ──────────────────────────────────────────────

export interface TodoRow {
  id: number;
  session_id: string | null;
  title: string;
  detail: string;
  status: "open" | "in_progress" | "blocked" | "done";
  priority: number;
  tags: string;
  position: number;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

export interface TodoInput {
  title: string;
  detail?: string;
  status?: TodoRow["status"];
  priority?: number;
  tags?: string[];
  session_id?: string | null;
}

export function addTodo(input: TodoInput): number {
  const d = getDb();
  const now = Date.now();
  const row = d
    .query(
      `INSERT INTO todos (session_id, title, detail, status, priority, tags, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.session_id ?? null,
      input.title,
      input.detail ?? "",
      input.status ?? "open",
      Math.max(0, Math.min(input.priority ?? 2, 4)),
      JSON.stringify(input.tags ?? []),
      (d.query("SELECT COALESCE(MAX(position), 0) + 1000 AS p FROM todos").get() as { p: number } | null)?.p ?? 1000,
      now,
      now,
    );
  return Number(row.lastInsertRowid);
}

export function listTodos(
  status?: TodoRow["status"] | "all",
  limit = 200,
): TodoRow[] {
  const d = getDb();
  if (!status || status === "all") {
    return d
      .query("SELECT * FROM todos ORDER BY (status = 'done'), priority ASC, position ASC, created_at ASC LIMIT ?")
      .all(limit) as TodoRow[];
  }
  return d
    .query("SELECT * FROM todos WHERE status = ? ORDER BY priority ASC, position ASC, created_at ASC LIMIT ?")
    .all(status, limit) as TodoRow[];
}

export function updateTodo(
  id: number,
  patch: Partial<TodoInput> & { position?: number },
): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    args.push(patch.title);
  }
  if (patch.detail !== undefined) {
    sets.push("detail = ?");
    args.push(patch.detail);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    sets.push(patch.status === "done" ? "done_at = ?" : "done_at = NULL");
    if (patch.status === "done") args.push(Date.now());
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    args.push(Math.max(0, Math.min(patch.priority, 4)));
  }
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    args.push(JSON.stringify(patch.tags));
  }
  if (patch.position !== undefined) {
    sets.push("position = ?");
    args.push(patch.position);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = ?");
  args.push(Date.now(), id);
  const r = getDb()
    .query(`UPDATE todos SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(args as never[]));
  return r.changes > 0;
}

export function deleteTodo(id: number): boolean {
  return getDb().query("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
}

export function todoStats(): Record<TodoRow["status"], number> & { total: number } {
  const rows = getDb()
    .query("SELECT status, COUNT(*) AS n FROM todos GROUP BY status")
    .all() as Array<{ status: TodoRow["status"]; n: number }>;
  const out = { open: 0, in_progress: 0, blocked: 0, done: 0, total: 0 };
  for (const r of rows) {
    out[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

export function vacuum(): void {
  getDb().exec("VACUUM;");
}

export function walCheckpoint(): void {
  try {
    getDb().exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch (e) {
    log.warn("wal_checkpoint falló", { err: String(e) });
  }
}

export function dbStats(): Record<string, unknown> {
  const d = getDb();
  const pageCount = (d.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  const pageSize = (d.query("PRAGMA page_size").get() as { page_size: number }).page_size;
  return {
    path: CONFIG.db_path,
    fts5: ftsEnabled,
    size_bytes: pageCount * pageSize,
    episodic: episodicStats(),
    backlog: backlogStats(),
    skills: (d.query("SELECT COUNT(*) c FROM skills_registry").get() as { c: number }).c,
    sessions: (d.query("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c,
    tool_calls: (d.query("SELECT COUNT(*) c FROM tool_calls").get() as { c: number }).c,
  };
}

/** Cierra (si lo hay) — para tests y apagado ordenado. */
export function closeDb(): void {
  if (db) {
    try {
      walCheckpoint();
      db.close();
    } catch {
      /* ya cerrada */
    }
    db = null;
    stmtCache.clear();
  }
}
