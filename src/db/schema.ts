import { createClient, type Client } from "@libsql/client";

export function createDbClient(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error("TURSO_DATABASE_URL environment variable is required");
  }

  return createClient({
    url,
    authToken,
  });
}

export async function initializeDatabase(client: Client): Promise<void> {
  // Create tables
  await client.executeMultiple(`
    -- Processed emails tracking
    CREATE TABLE IF NOT EXISTS processed_emails (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      from_email TEXT NOT NULL,
      from_name TEXT,
      subject TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      classification TEXT NOT NULL,
      confidence REAL NOT NULL,
      reasoning TEXT,
      content_summary TEXT,
      labels_applied TEXT,
      action_taken TEXT,
      content_format TEXT DEFAULT 'standard',
      digest_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_processed_emails_from ON processed_emails(from_email);
    CREATE INDEX IF NOT EXISTS idx_processed_emails_received ON processed_emails(received_at);
    CREATE INDEX IF NOT EXISTS idx_processed_emails_classification ON processed_emails(classification);

    -- Sender profiles for relationship tracking
    CREATE TABLE IF NOT EXISTS sender_profiles (
      email TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      relationship_type TEXT NOT NULL DEFAULT 'unknown',
      formality REAL DEFAULT 0.5,
      avg_response_length INTEGER DEFAULT 0,
      greeting_patterns TEXT DEFAULT '[]',
      signoff_patterns TEXT DEFAULT '[]',
      uses_emoji INTEGER DEFAULT 0,
      uses_exclamations INTEGER DEFAULT 0,
      emails_received INTEGER DEFAULT 0,
      emails_sent INTEGER DEFAULT 0,
      avg_response_time_hours REAL,
      last_interaction TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sender_profiles_domain ON sender_profiles(domain);
    CREATE INDEX IF NOT EXISTS idx_sender_profiles_type ON sender_profiles(relationship_type);

    -- User configuration and rules
    CREATE TABLE IF NOT EXISTS user_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Sync state for JMAP
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Digest tracking
    CREATE TABLE IF NOT EXISTS digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cleanup_token TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      generated_at TEXT,
      sent_at TEXT,
      cleaned_at TEXT,
      email_count INTEGER DEFAULT 0,
      summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_digests_generated ON digests(generated_at);

    -- User corrections for learning
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id TEXT NOT NULL,
      original_classification TEXT NOT NULL,
      corrected_classification TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      email_subject TEXT,
      email_from TEXT,
      email_preview TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_corrections_classification ON corrections(corrected_classification);
  `);

  // Migration: Add content_format column if it doesn't exist (for existing databases)
  try {
    await client.execute(
      "ALTER TABLE processed_emails ADD COLUMN content_format TEXT DEFAULT 'standard'"
    );
  } catch {
    // Column already exists, ignore error
  }

  // Migration: Add content_summary column to processed_emails
  try {
    await client.execute(
      "ALTER TABLE processed_emails ADD COLUMN content_summary TEXT"
    );
  } catch {
    // Column already exists, ignore error
  }

  // Migration: Add digest_id column to processed_emails
  try {
    await client.execute(
      "ALTER TABLE processed_emails ADD COLUMN digest_id INTEGER"
    );
  } catch {
    // Column already exists, ignore error
  }

  // Migration: Add new columns to digests table
  try {
    await client.execute(
      "ALTER TABLE digests ADD COLUMN cleanup_token TEXT"
    );
  } catch {
    // Column already exists, ignore error
  }

  try {
    await client.execute(
      "ALTER TABLE digests ADD COLUMN status TEXT DEFAULT 'pending'"
    );
  } catch {
    // Column already exists, ignore error
  }

  try {
    await client.execute(
      "ALTER TABLE digests ADD COLUMN cleaned_at TEXT"
    );
  } catch {
    // Column already exists, ignore error
  }

  // Create indexes for new columns (after migrations)
  try {
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_digests_status ON digests(status)"
    );
  } catch {
    // Index may fail if column doesn't exist yet
  }

  try {
    await client.execute(
      "CREATE INDEX IF NOT EXISTS idx_digests_token ON digests(cleanup_token)"
    );
  } catch {
    // Index may fail if column doesn't exist yet
  }
}
