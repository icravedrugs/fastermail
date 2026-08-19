import type { Client } from "@libsql/client";

// Types

export type ContentFormat =
  | "standard"
  | "link_collection"
  | "article"
  | "announcement"
  | "transactional";

export interface ProcessedEmail {
  id: string;
  threadId: string | null;
  fromEmail: string;
  fromName: string | null;
  subject: string | null;
  receivedAt: string;
  processedAt: string;
  classification: string;
  confidence: number;
  reasoning: string | null;
  contentSummary: string | null;
  labelsApplied: string | null;
  actionTaken: string | null;
  contentFormat: ContentFormat;
  digestId: number | null;
  listId: string | null;
  baseClassification: string | null;
  configHash: string | null;
}

export type ActivityEventType =
  | "seen"
  | "unseen"
  | "moved"
  | "destroyed"
  | "answered"
  | "flagged"
  | "digest_included"
  | "digest_click"
  | "watcher_reset";

export type ActivityEventSource = "user" | "fastermail";

export interface ActivityEvent {
  emailId: string | null;
  type: ActivityEventType;
  // When the action is claimed to have happened. Watcher events cannot know
  // this (JMAP's change feed is timestamp-free), so for them at == observedAt
  // and any latency finer than the poll interval is below the resolution floor.
  at?: string;
  // When we observed the change; defaults to now.
  observedAt?: string;
  source: ActivityEventSource;
  detail?: Record<string, unknown>;
}

export interface EmailStateSnapshot {
  id: string;
  mailboxIds: string[];
  seen: boolean;
  answered: boolean;
  flagged: boolean;
}

export interface SenderProfile {
  email: string;
  domain: string;
  relationshipType: "service" | "business" | "personal" | "vip" | "unknown";
  formality: number;
  avgResponseLength: number;
  greetingPatterns: string[];
  signoffPatterns: string[];
  usesEmoji: boolean;
  usesExclamations: boolean;
  emailsReceived: number;
  emailsSent: number;
  avgResponseTimeHours: number | null;
  lastInteraction: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DigestStatus = "pending" | "sent" | "cleaned";

export interface DigestRecord {
  id: number;
  cleanupToken: string | null;
  status: DigestStatus;
  generatedAt: string | null;
  sentAt: string | null;
  cleanedAt: string | null;
  emailCount: number;
  summary: string | null;
}

export interface Correction {
  id?: number;
  emailId: string;
  originalClassification: string;
  correctedClassification: string;
  reasoning: string;
  emailSubject: string | null;
  emailFrom: string | null;
  emailPreview: string | null;
  createdAt?: string;
}

// Store class

export class Store {
  constructor(private readonly db: Client) {}

  // ============ Processed Emails ============

  private mapProcessedEmail(row: Record<string, unknown>): ProcessedEmail {
    return {
      id: row.id as string,
      threadId: row.thread_id as string | null,
      fromEmail: row.from_email as string,
      fromName: row.from_name as string | null,
      subject: row.subject as string | null,
      receivedAt: row.received_at as string,
      processedAt: row.processed_at as string,
      classification: row.classification as string,
      confidence: row.confidence as number,
      reasoning: row.reasoning as string | null,
      contentSummary: row.content_summary as string | null,
      labelsApplied: row.labels_applied as string | null,
      actionTaken: row.action_taken as string | null,
      contentFormat: (row.content_format as ContentFormat) || "standard",
      digestId: row.digest_id as number | null,
      listId: (row.list_id as string | null) ?? null,
      baseClassification: (row.base_classification as string | null) ?? null,
      configHash: (row.config_hash as string | null) ?? null,
    };
  }

  async isEmailProcessed(emailId: string): Promise<boolean> {
    const result = await this.db.execute({
      sql: "SELECT 1 FROM processed_emails WHERE id = ?",
      args: [emailId],
    });
    return result.rows.length > 0;
  }

  async saveProcessedEmail(email: ProcessedEmail): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO processed_emails
            (id, thread_id, from_email, from_name, subject, received_at,
             processed_at, classification, confidence, reasoning, content_summary, labels_applied, action_taken, content_format, digest_id, list_id, base_classification, config_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        email.id,
        email.threadId,
        email.fromEmail,
        email.fromName,
        email.subject,
        email.receivedAt,
        email.processedAt,
        email.classification,
        email.confidence,
        email.reasoning,
        email.contentSummary,
        email.labelsApplied,
        email.actionTaken,
        email.contentFormat,
        email.digestId,
        email.listId,
        email.baseClassification,
        email.configHash,
      ],
    });
  }

  async getProcessedEmailsSince(since: string): Promise<ProcessedEmail[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM processed_emails
            WHERE processed_at >= ?
            ORDER BY processed_at DESC`,
      args: [since],
    });

    return result.rows.map((row) => this.mapProcessedEmail(row));
  }

  async getProcessedEmailsByClassification(
    classification: string,
    limit: number = 100
  ): Promise<ProcessedEmail[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM processed_emails
            WHERE classification = ?
            ORDER BY processed_at DESC
            LIMIT ?`,
      args: [classification, limit],
    });

    return result.rows.map((row) => this.mapProcessedEmail(row));
  }

  // ============ Sender Profiles ============

  async getSenderProfile(email: string): Promise<SenderProfile | null> {
    const result = await this.db.execute({
      sql: "SELECT * FROM sender_profiles WHERE email = ?",
      args: [email],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      email: row.email as string,
      domain: row.domain as string,
      relationshipType: row.relationship_type as SenderProfile["relationshipType"],
      formality: row.formality as number,
      avgResponseLength: row.avg_response_length as number,
      greetingPatterns: JSON.parse(row.greeting_patterns as string),
      signoffPatterns: JSON.parse(row.signoff_patterns as string),
      usesEmoji: Boolean(row.uses_emoji),
      usesExclamations: Boolean(row.uses_exclamations),
      emailsReceived: row.emails_received as number,
      emailsSent: row.emails_sent as number,
      avgResponseTimeHours: row.avg_response_time_hours as number | null,
      lastInteraction: row.last_interaction as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  async saveSenderProfile(profile: SenderProfile): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO sender_profiles
            (email, domain, relationship_type, formality, avg_response_length,
             greeting_patterns, signoff_patterns, uses_emoji, uses_exclamations,
             emails_received, emails_sent, avg_response_time_hours, last_interaction,
             created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        profile.email,
        profile.domain,
        profile.relationshipType,
        profile.formality,
        profile.avgResponseLength,
        JSON.stringify(profile.greetingPatterns),
        JSON.stringify(profile.signoffPatterns),
        profile.usesEmoji ? 1 : 0,
        profile.usesExclamations ? 1 : 0,
        profile.emailsReceived,
        profile.emailsSent,
        profile.avgResponseTimeHours,
        profile.lastInteraction,
        profile.createdAt,
        profile.updatedAt,
      ],
    });
  }

  async incrementSenderReceived(email: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `UPDATE sender_profiles
            SET emails_received = emails_received + 1,
                last_interaction = ?,
                updated_at = ?
            WHERE email = ?`,
      args: [now, now, email],
    });
  }

  async incrementSenderSent(email: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `UPDATE sender_profiles
            SET emails_sent = emails_sent + 1,
                last_interaction = ?,
                updated_at = ?
            WHERE email = ?`,
      args: [now, now, email],
    });
  }

  async getAllSenderProfiles(): Promise<SenderProfile[]> {
    const result = await this.db.execute(
      "SELECT * FROM sender_profiles ORDER BY last_interaction DESC"
    );

    return result.rows.map((row) => ({
      email: row.email as string,
      domain: row.domain as string,
      relationshipType: row.relationship_type as SenderProfile["relationshipType"],
      formality: row.formality as number,
      avgResponseLength: row.avg_response_length as number,
      greetingPatterns: JSON.parse(row.greeting_patterns as string),
      signoffPatterns: JSON.parse(row.signoff_patterns as string),
      usesEmoji: Boolean(row.uses_emoji),
      usesExclamations: Boolean(row.uses_exclamations),
      emailsReceived: row.emails_received as number,
      emailsSent: row.emails_sent as number,
      avgResponseTimeHours: row.avg_response_time_hours as number | null,
      lastInteraction: row.last_interaction as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    }));
  }

  // ============ Sync State ============

  async getSyncState(key: string): Promise<string | null> {
    const result = await this.db.execute({
      sql: "SELECT value FROM sync_state WHERE key = ?",
      args: [key],
    });

    if (result.rows.length === 0) return null;
    return result.rows[0].value as string;
  }

  async setSyncState(key: string, value: string): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO sync_state (key, value, updated_at)
            VALUES (?, ?, ?)`,
      args: [key, value, new Date().toISOString()],
    });
  }

  // ============ User Config ============

  async getConfig<T>(key: string, defaultValue: T): Promise<T> {
    const result = await this.db.execute({
      sql: "SELECT value FROM user_config WHERE key = ?",
      args: [key],
    });

    if (result.rows.length === 0) return defaultValue;

    try {
      return JSON.parse(result.rows[0].value as string) as T;
    } catch {
      return defaultValue;
    }
  }

  async setConfig<T>(key: string, value: T): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO user_config (key, value, updated_at)
            VALUES (?, ?, ?)`,
      args: [key, JSON.stringify(value), new Date().toISOString()],
    });
  }

  // ============ Digests ============

  private generateCleanupToken(): string {
    return crypto.randomUUID();
  }

  async getPendingDigest(): Promise<DigestRecord> {
    const result = await this.db.execute(
      "SELECT * FROM digests WHERE status = 'pending' ORDER BY id DESC LIMIT 1"
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id as number,
        cleanupToken: row.cleanup_token as string | null,
        status: row.status as DigestStatus,
        generatedAt: row.generated_at as string | null,
        sentAt: row.sent_at as string | null,
        cleanedAt: row.cleaned_at as string | null,
        emailCount: row.email_count as number,
        summary: row.summary as string | null,
      };
    }

    // No pending digest exists, create one
    return this.createPendingDigest();
  }

  async createPendingDigest(): Promise<DigestRecord> {
    const token = this.generateCleanupToken();
    const now = new Date().toISOString();
    const result = await this.db.execute({
      sql: `INSERT INTO digests (cleanup_token, status, email_count, generated_at, summary)
            VALUES (?, 'pending', 0, ?, '')`,
      args: [token, now],
    });

    return {
      id: Number(result.lastInsertRowid),
      cleanupToken: token,
      status: "pending",
      generatedAt: now,
      sentAt: null,
      cleanedAt: null,
      emailCount: 0,
      summary: null,
    };
  }

  async markDigestSent(
    digestId: number,
    emailCount: number,
    summary: string
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.execute({
      sql: `UPDATE digests
            SET status = 'sent', generated_at = ?, sent_at = ?, email_count = ?, summary = ?
            WHERE id = ?`,
      args: [now, now, emailCount, summary, digestId],
    });
  }

  async getDigestByToken(token: string): Promise<DigestRecord | null> {
    const result = await this.db.execute({
      sql: "SELECT * FROM digests WHERE cleanup_token = ?",
      args: [token],
    });

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id as number,
      cleanupToken: row.cleanup_token as string | null,
      status: row.status as DigestStatus,
      generatedAt: row.generated_at as string | null,
      sentAt: row.sent_at as string | null,
      cleanedAt: row.cleaned_at as string | null,
      emailCount: row.email_count as number,
      summary: row.summary as string | null,
    };
  }

  async getEmailsByDigestId(digestId: number): Promise<ProcessedEmail[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM processed_emails WHERE digest_id = ? ORDER BY received_at DESC`,
      args: [digestId],
    });

    return result.rows.map((row) => this.mapProcessedEmail(row));
  }

  async markDigestCleaned(digestId: number): Promise<void> {
    await this.db.execute({
      sql: `UPDATE digests SET status = 'cleaned', cleaned_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), digestId],
    });
  }

  async getLastDigest(): Promise<DigestRecord | null> {
    const result = await this.db.execute(
      "SELECT * FROM digests WHERE status != 'pending' ORDER BY generated_at DESC LIMIT 1"
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id as number,
      cleanupToken: row.cleanup_token as string | null,
      status: row.status as DigestStatus,
      generatedAt: row.generated_at as string | null,
      sentAt: row.sent_at as string | null,
      cleanedAt: row.cleaned_at as string | null,
      emailCount: row.email_count as number,
      summary: row.summary as string | null,
    };
  }

  // ============ Stats ============

  async getEmailStats(): Promise<{
    total: number;
    byClassification: Record<string, number>;
    last24h: number;
  }> {
    const totalResult = await this.db.execute(
      "SELECT COUNT(*) as count FROM processed_emails"
    );
    const total = totalResult.rows[0].count as number;

    const byClassification: Record<string, number> = {};
    const classResult = await this.db.execute(
      `SELECT classification, COUNT(*) as count
       FROM processed_emails
       GROUP BY classification`
    );

    for (const row of classResult.rows) {
      byClassification[row.classification as string] = row.count as number;
    }

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const last24hResult = await this.db.execute({
      sql: "SELECT COUNT(*) as count FROM processed_emails WHERE processed_at >= ?",
      args: [yesterday],
    });
    const last24h = last24hResult.rows[0].count as number;

    return { total, byClassification, last24h };
  }

  // ============ Corrections ============

  async saveCorrection(correction: Correction): Promise<number> {
    const result = await this.db.execute({
      sql: `INSERT INTO corrections
            (email_id, original_classification, corrected_classification, reasoning,
             email_subject, email_from, email_preview, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        correction.emailId,
        correction.originalClassification,
        correction.correctedClassification,
        correction.reasoning,
        correction.emailSubject,
        correction.emailFrom,
        correction.emailPreview,
        new Date().toISOString(),
      ],
    });

    return Number(result.lastInsertRowid);
  }

  async getRecentCorrections(limit: number = 10): Promise<Correction[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM corrections
            ORDER BY created_at DESC
            LIMIT ?`,
      args: [limit],
    });

    return result.rows.map((row) => ({
      id: row.id as number,
      emailId: row.email_id as string,
      originalClassification: row.original_classification as string,
      correctedClassification: row.corrected_classification as string,
      reasoning: row.reasoning as string,
      emailSubject: row.email_subject as string | null,
      emailFrom: row.email_from as string | null,
      emailPreview: row.email_preview as string | null,
      createdAt: row.created_at as string,
    }));
  }

  async getCorrectionsByCategory(
    classification: string
  ): Promise<Correction[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM corrections
            WHERE corrected_classification = ?
            ORDER BY created_at DESC`,
      args: [classification],
    });

    return result.rows.map((row) => ({
      id: row.id as number,
      emailId: row.email_id as string,
      originalClassification: row.original_classification as string,
      correctedClassification: row.corrected_classification as string,
      reasoning: row.reasoning as string,
      emailSubject: row.email_subject as string | null,
      emailFrom: row.email_from as string | null,
      emailPreview: row.email_preview as string | null,
      createdAt: row.created_at as string,
    }));
  }

  async getProcessedEmail(emailId: string): Promise<ProcessedEmail | null> {
    const result = await this.db.execute({
      sql: "SELECT * FROM processed_emails WHERE id = ?",
      args: [emailId],
    });

    if (result.rows.length === 0) return null;

    return this.mapProcessedEmail(result.rows[0]);
  }

  async updateEmailClassification(
    emailId: string,
    newClassification: string
  ): Promise<void> {
    // Corrections are the highest-signal rows in the corpus: preserve the
    // original classification in base_classification (first correction only)
    // and never restamp processed_at — the original triage time is data.
    await this.db.execute({
      sql: `UPDATE processed_emails
            SET base_classification = COALESCE(base_classification, classification),
                classification = ?
            WHERE id = ?`,
      args: [newClassification, emailId],
    });
  }

  async getProcessedEmailsByThreadId(threadId: string): Promise<ProcessedEmail[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM processed_emails WHERE thread_id = ? ORDER BY received_at DESC`,
      args: [threadId],
    });

    return result.rows.map((row) => this.mapProcessedEmail(row));
  }

  /**
   * Most recent real classification in a thread, for thread-level consistency.
   * Excludes 'skipped' rows and the legacy phantom 'Already labeled' rows.
   */
  async getLatestThreadClassification(
    threadId: string
  ): Promise<Pick<ProcessedEmail, "classification" | "confidence" | "contentFormat" | "configHash"> | null> {
    const result = await this.db.execute({
      sql: `SELECT classification, confidence, content_format, config_hash FROM processed_emails
            WHERE thread_id = ?
              AND classification != 'skipped'
              AND NOT (confidence = 1.0 AND reasoning = 'Already labeled')
            ORDER BY received_at DESC LIMIT 1`,
      args: [threadId],
    });

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      classification: row.classification as string,
      confidence: row.confidence as number,
      contentFormat: (row.content_format as ContentFormat) || "standard",
      configHash: (row.config_hash as string | null) ?? null,
    };
  }

  /**
   * Move emails that were assigned to a digest but not rendered in it over to
   * the next pending digest, so they appear in a future digest instead of
   * silently belonging to a sent one.
   */
  async reassignDigestEmails(
    fromDigestId: number,
    toDigestId: number,
    renderedIds: string[]
  ): Promise<number> {
    const placeholders = renderedIds.map(() => "?").join(",");
    const result = await this.db.execute({
      sql: `UPDATE processed_emails SET digest_id = ?
            WHERE digest_id = ?${renderedIds.length > 0 ? ` AND id NOT IN (${placeholders})` : ""}`,
      args: [toDigestId, fromDigestId, ...renderedIds],
    });
    return result.rowsAffected;
  }

  async getExpiredOtpEmails(cutoffIso: string): Promise<ProcessedEmail[]> {
    const result = await this.db.execute({
      sql: `SELECT * FROM processed_emails
            WHERE action_taken = 'otp-bypass' AND received_at < ?`,
      args: [cutoffIso],
    });

    return result.rows.map((row) => this.mapProcessedEmail(row));
  }

  async setActionTaken(emailId: string, actionTaken: string): Promise<void> {
    await this.db.execute({
      sql: `UPDATE processed_emails SET action_taken = ? WHERE id = ?`,
      args: [actionTaken, emailId],
    });
  }

  // ============ Activity Events ============

  async recordEvent(event: ActivityEvent): Promise<void> {
    const observedAt = event.observedAt ?? new Date().toISOString();
    await this.db.execute({
      sql: `INSERT INTO events (email_id, type, at, observed_at, source, detail)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        event.emailId,
        event.type,
        event.at ?? observedAt,
        observedAt,
        event.source,
        event.detail ? JSON.stringify(event.detail) : null,
      ],
    });
  }

  // ============ Email State Snapshots ============

  async getEmailStateSnapshots(
    ids: string[]
  ): Promise<Map<string, EmailStateSnapshot>> {
    const snapshots = new Map<string, EmailStateSnapshot>();

    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const placeholders = chunk.map(() => "?").join(",");
      const result = await this.db.execute({
        sql: `SELECT * FROM email_state WHERE id IN (${placeholders})`,
        args: chunk,
      });

      for (const row of result.rows) {
        snapshots.set(row.id as string, {
          id: row.id as string,
          mailboxIds: JSON.parse(row.mailbox_ids as string),
          seen: Boolean(row.seen),
          answered: Boolean(row.answered),
          flagged: Boolean(row.flagged),
        });
      }
    }

    return snapshots;
  }

  async upsertEmailStateSnapshot(snapshot: EmailStateSnapshot): Promise<void> {
    await this.db.execute({
      sql: `INSERT OR REPLACE INTO email_state
            (id, mailbox_ids, seen, answered, flagged, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        snapshot.id,
        JSON.stringify(snapshot.mailboxIds),
        snapshot.seen ? 1 : 0,
        snapshot.answered ? 1 : 0,
        snapshot.flagged ? 1 : 0,
        new Date().toISOString(),
      ],
    });
  }

  async deleteEmailStateSnapshot(id: string): Promise<void> {
    await this.db.execute({
      sql: "DELETE FROM email_state WHERE id = ?",
      args: [id],
    });
  }

}
