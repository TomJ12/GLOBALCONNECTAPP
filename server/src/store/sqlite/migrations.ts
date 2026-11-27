/**
 * The schema, as numbered, forward-only migrations. Never edit one that has
 * shipped: add the next. Each runs once, in a transaction, at start-up.
 */
const ACCOUNT_COLUMNS = `
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT,
  -- AES-256-GCM ciphertext (see keys.ts), never the key itself. totp_key_id says which key encrypted it.
  totp_secret TEXT,
  totp_key_id TEXT,
  last_totp_step INTEGER NOT NULL DEFAULT 0,
  recovery_code_hashes TEXT NOT NULL DEFAULT '[]',
  activated_at INTEGER,
  disabled_at INTEGER,
  last_sign_in_at INTEGER,
  known_sources TEXT NOT NULL DEFAULT '[]'`;

/** A keyed table whose row is one JSON document, with indexes on the fields it is looked up by. */
const keyed = (name: string, indexed: string[] = []): string =>
  `CREATE TABLE ${name} (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;\n` +
  indexed.map((field) => `CREATE INDEX ${name}_${field} ON ${name} (json_extract(data, '$.${field}'));`).join('\n');

const AUDIT_COLUMNS = `
  id TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  actor_type TEXT NOT NULL, actor_id TEXT, actor_label TEXT NOT NULL,
  target_type TEXT, target_id TEXT, target_label TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  source TEXT NOT NULL,
  detail TEXT NOT NULL,
  -- Each entry is chained to the one before it: hash = HMAC(key, prev_hash + entry). key_id says which key.
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  key_id TEXT NOT NULL`;

/** The four triggers that make the audit tables append-only, exactly as they must be found in the database (`audit:verify` compares). */
export const AUDIT_TRIGGERS: Record<string, string> = {
  audit_log_no_update: `CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: entries cannot be changed'); END`,
  audit_log_no_delete: `CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
WHEN NOT EXISTS (SELECT 1 FROM audit_archive a WHERE a.seq = OLD.seq AND a.hash = OLD.hash AND a.id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: entries cannot be removed'); END`,
  audit_archive_no_update: `CREATE TRIGGER audit_archive_no_update BEFORE UPDATE ON audit_archive
BEGIN SELECT RAISE(ABORT, 'audit_archive is append-only: entries cannot be changed'); END`,
  audit_archive_no_delete: `CREATE TRIGGER audit_archive_no_delete BEFORE DELETE ON audit_archive
BEGIN SELECT RAISE(ABORT, 'audit_archive is append-only: entries cannot be removed'); END`,
};

export const MIGRATIONS: string[] = [
  // 1: accounts, directory, auth state, approval requests, audit log.
  `
-- One encrypted marker: opening the database with the wrong key is noticed at start-up, not at somebody's sign-in.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE users (${ACCOUNT_COLUMNS}) STRICT;
CREATE TABLE ops_users (${ACCOUNT_COLUMNS},
  role TEXT NOT NULL CHECK (role IN ('ops', 'ops_admin'))) STRICT;
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_contact_id TEXT NOT NULL,
  deactivated_at INTEGER,
  previous_name TEXT,
  renamed_at INTEGER) STRICT;
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users (id),
  company_id TEXT NOT NULL REFERENCES companies (id),
  role TEXT NOT NULL CHECK (role IN ('creator', 'approver', 'admin')),
  PRIMARY KEY (user_id, company_id)) STRICT;
CREATE INDEX memberships_company ON memberships (company_id);

${keyed('activations', ['userId'])}
${keyed('challenges', ['userId'])}
${keyed('sessions', ['userId'])}
${keyed('step_ups', ['userId', 'sessionId'])}
${keyed('attempts', ['subject'])}
${keyed('ops_activations', ['userId'])}
${keyed('ops_challenges', ['userId'])}
${keyed('ops_sessions', ['userId'])}
${keyed('ops_attempts', ['subject'])}
${keyed('ops_approvals', ['status'])}
${keyed('provider_keys')}
-- DEVELOPMENT ONLY: activation codes the server itself printed for the sample accounts, so a restart can print them
-- again. Never written outside development mode.
${keyed('dev_seed_codes')}

CREATE TABLE audit_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ${AUDIT_COLUMNS}) STRICT;
CREATE INDEX audit_log_at ON audit_log (at);
-- Older entries are MOVED here (same seq, same hash) when the live table grows large. Nothing is ever dropped.
CREATE TABLE audit_archive (seq INTEGER PRIMARY KEY, ${AUDIT_COLUMNS}, archived_at INTEGER NOT NULL) STRICT;
-- The end of the chain, so that removing the newest entries is detectable too.
CREATE TABLE audit_head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, hash TEXT NOT NULL) STRICT;

-- Append-only, enforced by the database as well as by the code having no such statement. A live entry may leave
-- only by having been copied, unchanged, to the archive.
${Object.values(AUDIT_TRIGGERS).join(';\n')};
`,
  // 2: payment approvals. The company's policy, and the payments the server holds until they are approved.
  `
ALTER TABLE companies ADD COLUMN approvals_required INTEGER NOT NULL DEFAULT 1 CHECK (approvals_required IN (0, 1, 2));
-- One JSON document per held payment. The key is derived from the company and the creator's idempotency key,
-- so the same request can never be stored twice.
CREATE TABLE held_payments (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX held_payments_id ON held_payments (json_extract(data, '$.id'));
CREATE INDEX held_payments_company ON held_payments (json_extract(data, '$.companyId'));
CREATE INDEX held_payments_status ON held_payments (json_extract(data, '$.status'));
`,
  // 3: ops console confirmations. A used confirmation token is remembered until it would have expired, so it works once.
  `
CREATE TABLE ops_confirmations (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
`,
  // 4: the end of the audit log is signed (count and MAC, filled in by the store, which has the key); no two
  // companies can share a provider account or a name, whatever the code checked first (name_key is the name as
  // it is compared: filled in by the store).
  `
ALTER TABLE audit_head ADD COLUMN count INTEGER;
ALTER TABLE audit_head ADD COLUMN mac TEXT;
ALTER TABLE audit_head ADD COLUMN key_id TEXT;
ALTER TABLE companies ADD COLUMN name_key TEXT;
CREATE UNIQUE INDEX companies_provider_account ON companies (provider_key, provider_account_id);
CREATE UNIQUE INDEX companies_name_key ON companies (name_key);
`,
  // 5: how far the archive reaches becomes part of the signed end of the audit log; payments sent straight to the
  // provider (no approval rule) are recorded by key BEFORE the provider is asked. The store also writes its keyed
  // record of the database's state (schema version, whether it was ever used in development) in this step.
  `
ALTER TABLE audit_head ADD COLUMN archived_through INTEGER;
CREATE TABLE direct_payments (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
`,
  // 6: the email outbox. Every message is written here first and sent from here (mail/queue.ts).
  `
CREATE TABLE mail_outbox (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX mail_outbox_status ON mail_outbox (json_extract(data, '$.status'));
`,
  // 7: self-service password reset (clients and staff), and authenticator resets waiting out their delay.
  `
CREATE TABLE password_resets (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX password_resets_user ON password_resets (json_extract(data, '$.userId'));
CREATE TABLE ops_password_resets (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX ops_password_resets_user ON ops_password_resets (json_extract(data, '$.userId'));
CREATE TABLE authenticator_resets (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX authenticator_resets_user ON authenticator_resets (json_extract(data, '$.userId'));
CREATE INDEX authenticator_resets_status ON authenticator_resets (json_extract(data, '$.status'));
`,
  // 8: each company's FX margin, and what was earned on each conversion. Server-side only.
  `
CREATE TABLE company_margins (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE TABLE fx_revenue (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX fx_revenue_company ON fx_revenue (json_extract(data, '$.companyId'));
CREATE INDEX fx_revenue_conversion ON fx_revenue (json_extract(data, '$.conversionId'));
`,
  // 9: rate alerts (checked by the server), each person's in-app notifications and their notification preferences.
  `
CREATE TABLE rate_alerts (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX rate_alerts_user ON rate_alerts (json_extract(data, '$.userId'));
CREATE INDEX rate_alerts_status ON rate_alerts (json_extract(data, '$.status'));
CREATE TABLE notifications (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX notifications_user ON notifications (json_extract(data, '$.userId'));
CREATE TABLE notification_prefs (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
`,
  // 10: the outbox is read through indexes (who it is to, the hour it was sent) instead of in full; held quotes are kept.
  `
CREATE INDEX mail_outbox_to ON mail_outbox (json_extract(data, '$.to'));
CREATE INDEX mail_outbox_sent_hour ON mail_outbox (json_extract(data, '$.sentHour'));
-- Quotes this server is holding for clients (they used to be in memory only).
CREATE TABLE held_quotes (key TEXT PRIMARY KEY, data TEXT NOT NULL) STRICT;
CREATE INDEX held_quotes_company ON held_quotes (json_extract(data, '$.companyId'));
-- Held payments are looked up by when their status last changed (the notification scan reads only what is recent).
CREATE INDEX held_payments_status_at ON held_payments (json_extract(data, '$.statusAt'));
`,
  // 11: conversions whose booker has still to be told that the booking differs from the quote are found through an index.
  `
CREATE INDEX fx_revenue_untold ON fx_revenue (json_extract(data, '$.untold'));
`,
];
