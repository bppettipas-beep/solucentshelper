const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, 'solucents_helper.db');

// Stale .db-shm (shared-memory) files left by a crash cause SQLITE_IOERR on the next
// write. The .db-shm is always safe to delete — SQLite recreates it from the WAL.
try { fs.unlinkSync(dbPath + '-shm'); } catch {}

const db = new DatabaseSync(dbPath);

// DELETE journal mode: checkpoints any existing WAL, then removes WAL/SHM files.
// WAL mode is unnecessary for a single-process bot and caused disk I/O errors on
// Windows when .db-shm was left stale from a previous crash.
db.exec('PRAGMA journal_mode = DELETE');
db.exec('PRAGMA foreign_keys = ON');

// ─── Migrations ───────────────────────────────────────────────────────────────
try { db.exec('ALTER TABLE ticket_config ADD COLUMN support_role_ids TEXT'); } catch {}
try { db.exec('ALTER TABLE ticket_questions ADD COLUMN category_id TEXT'); } catch {}
try { db.exec('ALTER TABLE ticket_questions ADD COLUMN support_role_ids TEXT'); } catch {}

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  -- ── Ticket System ──────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS ticket_config (
    guild_id         TEXT PRIMARY KEY,
    category_id      TEXT,
    log_channel_id   TEXT,
    support_role_id  TEXT,
    support_role_ids TEXT,
    panel_channel_id TEXT,
    panel_message_id TEXT,
    next_ticket_num  INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id        TEXT NOT NULL,
    channel_id      TEXT NOT NULL UNIQUE,
    ticket_num      INTEGER NOT NULL,
    owner_id        TEXT NOT NULL,
    claimed_by      TEXT,
    status          TEXT DEFAULT 'open',   -- open | closed | archived
    reason          TEXT,
    created_at      INTEGER DEFAULT (strftime('%s','now')),
    closed_at       INTEGER
  );

  CREATE TABLE IF NOT EXISTS ticket_members (
    ticket_id  INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    PRIMARY KEY (ticket_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS ticket_questions (
    guild_id  TEXT NOT NULL,
    prefix    TEXT NOT NULL,
    questions TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (guild_id, prefix)
  );

  -- ── Donut System ────────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS donut_config (
    guild_id          TEXT PRIMARY KEY,
    announce_channel_id TEXT,
    frequency         TEXT DEFAULT 'biweekly',  -- weekly | biweekly | monthly
    next_round_at     INTEGER,
    cron_expression   TEXT DEFAULT '0 9 * * 1', -- every Monday 9 AM
    active            INTEGER DEFAULT 1,
    prompt_category   TEXT DEFAULT 'general'
  );

  CREATE TABLE IF NOT EXISTS donut_members (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    status     TEXT DEFAULT 'active',  -- active | snoozed | opted_out
    snooze_until INTEGER,
    joined_at  INTEGER DEFAULT (strftime('%s','now')),
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS donut_rounds (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT NOT NULL,
    started_at INTEGER DEFAULT (strftime('%s','now')),
    ended_at   INTEGER,
    status     TEXT DEFAULT 'active'  -- active | completed
  );

  CREATE TABLE IF NOT EXISTS donut_pairings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id    INTEGER REFERENCES donut_rounds(id) ON DELETE CASCADE,
    guild_id    TEXT NOT NULL,
    user1_id    TEXT NOT NULL,
    user2_id    TEXT NOT NULL,
    status      TEXT DEFAULT 'pending',  -- pending | completed | skipped
    dm_sent     INTEGER DEFAULT 0,
    completed_at INTEGER,
    prompt      TEXT
  );

  CREATE TABLE IF NOT EXISTS donut_stats (
    guild_id        TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    donuts_total    INTEGER DEFAULT 0,
    donuts_completed INTEGER DEFAULT 0,
    donuts_skipped  INTEGER DEFAULT 0,
    current_streak  INTEGER DEFAULT 0,
    best_streak     INTEGER DEFAULT 0,
    last_active_round INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );

  -- ── Strike System ───────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS strike_config (
    guild_id TEXT PRIMARY KEY,
    role1_id TEXT,
    role2_id TEXT,
    role3_id TEXT
  );

  CREATE TABLE IF NOT EXISTS strikes (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    count    INTEGER DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
`);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ticketConfig = {
  get: db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?'),
  upsert: db.prepare(`
    INSERT INTO ticket_config (guild_id, category_id, log_channel_id, support_role_id,
      support_role_ids, panel_channel_id, panel_message_id, next_ticket_num)
    VALUES (@guild_id, @category_id, @log_channel_id, @support_role_id,
      @support_role_ids, @panel_channel_id, @panel_message_id, @next_ticket_num)
    ON CONFLICT(guild_id) DO UPDATE SET
      category_id      = COALESCE(excluded.category_id, category_id),
      log_channel_id   = COALESCE(excluded.log_channel_id, log_channel_id),
      support_role_id  = COALESCE(excluded.support_role_id, support_role_id),
      support_role_ids = COALESCE(excluded.support_role_ids, support_role_ids),
      panel_channel_id = COALESCE(excluded.panel_channel_id, panel_channel_id),
      panel_message_id = COALESCE(excluded.panel_message_id, panel_message_id),
      next_ticket_num  = COALESCE(excluded.next_ticket_num, next_ticket_num)
  `),
  bumpTicketNum: db.prepare(`
    UPDATE ticket_config SET next_ticket_num = next_ticket_num + 1 WHERE guild_id = ?
  `),
};

// ─── Helper: get all support role IDs from config ─────────────────────────────
function getSupportRoleIds(cfg) {
  if (cfg?.support_role_ids) {
    try { return JSON.parse(cfg.support_role_ids); } catch {}
  }
  if (cfg?.support_role_id) return [cfg.support_role_id];
  return [];
}

const ticketQuestions = {
  get: db.prepare('SELECT * FROM ticket_questions WHERE guild_id = ? AND prefix = ?'),
  upsert: db.prepare(`
    INSERT INTO ticket_questions (guild_id, prefix, questions, category_id, support_role_ids)
    VALUES (@guild_id, @prefix, @questions, @category_id, @support_role_ids)
    ON CONFLICT(guild_id, prefix) DO UPDATE SET
      questions        = COALESCE(excluded.questions, questions),
      category_id      = excluded.category_id,
      support_role_ids = excluded.support_role_ids
  `),
};

const tickets = {
  create: db.prepare(`
    INSERT INTO tickets (guild_id, channel_id, ticket_num, owner_id, reason)
    VALUES (@guild_id, @channel_id, @ticket_num, @owner_id, @reason)
  `),
  getByChannel: db.prepare('SELECT * FROM tickets WHERE channel_id = ?'),
  getById: db.prepare('SELECT * FROM tickets WHERE id = ?'),
  listOpen: db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND status = 'open'"),
  update: db.prepare(`
    UPDATE tickets SET status = @status, claimed_by = @claimed_by, closed_at = @closed_at
    WHERE id = @id
  `),
  addMember: db.prepare('INSERT OR IGNORE INTO ticket_members (ticket_id, user_id) VALUES (?, ?)'),
  removeMember: db.prepare('DELETE FROM ticket_members WHERE ticket_id = ? AND user_id = ?'),
  getMembers: db.prepare('SELECT user_id FROM ticket_members WHERE ticket_id = ?'),
};

const donutConfig = {
  get: db.prepare('SELECT * FROM donut_config WHERE guild_id = ?'),
  upsert: db.prepare(`
    INSERT INTO donut_config (guild_id, announce_channel_id, frequency, next_round_at,
      cron_expression, active, prompt_category)
    VALUES (@guild_id, @announce_channel_id, @frequency, @next_round_at,
      @cron_expression, @active, @prompt_category)
    ON CONFLICT(guild_id) DO UPDATE SET
      announce_channel_id = COALESCE(excluded.announce_channel_id, announce_channel_id),
      frequency           = COALESCE(excluded.frequency, frequency),
      next_round_at       = COALESCE(excluded.next_round_at, next_round_at),
      cron_expression     = COALESCE(excluded.cron_expression, cron_expression),
      active              = COALESCE(excluded.active, active),
      prompt_category     = COALESCE(excluded.prompt_category, prompt_category)
  `),
};

const donutMembers = {
  get: db.prepare('SELECT * FROM donut_members WHERE guild_id = ? AND user_id = ?'),
  getActive: db.prepare(`
    SELECT * FROM donut_members
    WHERE guild_id = ? AND status = 'active'
    AND (snooze_until IS NULL OR snooze_until < strftime('%s','now'))
  `),
  upsert: db.prepare(`
    INSERT INTO donut_members (guild_id, user_id, status, snooze_until)
    VALUES (@guild_id, @user_id, @status, @snooze_until)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      status       = excluded.status,
      snooze_until = excluded.snooze_until
  `),
  count: db.prepare("SELECT COUNT(*) as cnt FROM donut_members WHERE guild_id = ? AND status = 'active'"),
};

const donutRounds = {
  create: db.prepare('INSERT INTO donut_rounds (guild_id) VALUES (?) RETURNING *'),
  getActive: db.prepare("SELECT * FROM donut_rounds WHERE guild_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1"),
  getLatest: db.prepare('SELECT * FROM donut_rounds WHERE guild_id = ? ORDER BY started_at DESC LIMIT 1'),
  complete: db.prepare("UPDATE donut_rounds SET status = 'completed', ended_at = strftime('%s','now') WHERE id = ?"),
  listRecent: db.prepare('SELECT * FROM donut_rounds WHERE guild_id = ? ORDER BY started_at DESC LIMIT 10'),
};

const donutPairings = {
  create: db.prepare(`
    INSERT INTO donut_pairings (round_id, guild_id, user1_id, user2_id, prompt)
    VALUES (@round_id, @guild_id, @user1_id, @user2_id, @prompt)
  `),
  getByRound: db.prepare('SELECT * FROM donut_pairings WHERE round_id = ?'),
  getByUser: db.prepare(`
    SELECT * FROM donut_pairings
    WHERE guild_id = ? AND (user1_id = ? OR user2_id = ?)
    ORDER BY id DESC
  `),
  getPreviousPairs: db.prepare(`
    SELECT user1_id, user2_id FROM donut_pairings
    WHERE guild_id = ? AND (user1_id = ? OR user2_id = ?)
  `),
  updateStatus: db.prepare(`
    UPDATE donut_pairings
    SET status = @status, completed_at = @completed_at
    WHERE id = @id
  `),
  markDmSent: db.prepare('UPDATE donut_pairings SET dm_sent = 1 WHERE id = ?'),
  getById: db.prepare('SELECT * FROM donut_pairings WHERE id = ?'),
  getByUsers: db.prepare(`
    SELECT * FROM donut_pairings
    WHERE guild_id = ?
      AND ((user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?))
    ORDER BY id DESC LIMIT 1
  `),
};

const donutStats = {
  get: db.prepare('SELECT * FROM donut_stats WHERE guild_id = ? AND user_id = ?'),
  getLeaderboard: db.prepare(`
    SELECT * FROM donut_stats WHERE guild_id = ?
    ORDER BY donuts_completed DESC, current_streak DESC LIMIT 10
  `),
  upsertInit: db.prepare(`
    INSERT OR IGNORE INTO donut_stats (guild_id, user_id) VALUES (?, ?)
  `),
  incrementTotal: db.prepare(`
    UPDATE donut_stats SET donuts_total = donuts_total + 1 WHERE guild_id = ? AND user_id = ?
  `),
  recordComplete: db.prepare(`
    UPDATE donut_stats
    SET donuts_completed = donuts_completed + 1,
        current_streak   = current_streak + 1,
        best_streak      = MAX(best_streak, current_streak + 1),
        last_active_round = @round_id
    WHERE guild_id = @guild_id AND user_id = @user_id
  `),
  recordSkip: db.prepare(`
    UPDATE donut_stats
    SET donuts_skipped = donuts_skipped + 1,
        current_streak = 0
    WHERE guild_id = ? AND user_id = ?
  `),
};

const strikeConfig = {
  get:    db.prepare('SELECT * FROM strike_config WHERE guild_id = ?'),
  upsert: db.prepare(`
    INSERT INTO strike_config (guild_id, role1_id, role2_id, role3_id)
    VALUES (@guild_id, @role1_id, @role2_id, @role3_id)
    ON CONFLICT(guild_id) DO UPDATE SET
      role1_id = excluded.role1_id,
      role2_id = excluded.role2_id,
      role3_id = excluded.role3_id
  `),
};

const strikeDb = {
  get:       db.prepare('SELECT * FROM strikes WHERE guild_id = ? AND user_id = ?'),
  upsert:    db.prepare(`
    INSERT INTO strikes (guild_id, user_id, count) VALUES (?, ?, 1)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET count = count + 1
  `),
  reset:     db.prepare('DELETE FROM strikes WHERE guild_id = ? AND user_id = ?'),
};

module.exports = {
  db,
  ticketConfig,
  getSupportRoleIds,
  ticketQuestions,
  tickets,
  donutConfig,
  donutMembers,
  donutRounds,
  donutPairings,
  donutStats,
  strikeConfig,
  strikeDb,
};
