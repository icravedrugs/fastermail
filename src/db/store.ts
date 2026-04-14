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
  isNewsletter: boolean;
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

export type ItemTier = "must-read" | "nice-to-have" | "skip";
export type ReadwiseStatus = "pending" | "saved" | "failed" | "abandoned";

export interface NewsletterItem {
  id: number;
  emailId: string;
  url: string;
  title: string | null;
  description: string | null;
  tier: ItemTier;
  topicTag: string | null;
  confidence: number;
  reason: string | null;
  readwiseStatus: ReadwiseStatus | null;
  readwiseDocId: string | null;
  retryCount: number;
  nextRetryAfter: string | null;
  createdAt: string;
}

export interface TierCorrection {
  id: number;
  itemId: number;
  originalTier: ItemTier;
  correctedTier: ItemTier;
  createdAt: string;
}

export interface CorrectionToken {
  id: number;
  token: string;
  digestId: number;
  createdAt: string;
  expiresAt: string;
}

export type FeedbackSignal = 'highlight_created' | 'document_finished' | 'progress_update';

export interface ReadingFeedback {
  id: number;
  itemId: number;
  readwiseDocId: string | null;
  signalType: FeedbackSignal;
  readingProgress: number | null;
  highlightedText: string | null;
  eventTimestamp: string;
  processed: boolean;
  createdAt: string;
}

// Store class

export class Store {
  constructor(private readonly db: Client) {}

  // ============ Processed Emails ============

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
             processed_at, classification, confidence, reasoning, content_summary, labels_applied, action_taken, content_format, digest_id, is_newsletter)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        email.isNewsletter ? 1 : 0,
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

    return result.rows.map((row) => ({
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
      isNewsletter: Boolean(row.is_newsletter),
    }));
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

    return result.rows.map((row) => ({
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
      isNewsletter: Boolean(row.is_newsletter),
    }));
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

    return result.rows.map((row) => ({
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
      isNewsletter: Boolean(row.is_newsletter),
    }));
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

    const row = result.rows[0];
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
      isNewsletter: Boolean(row.is_newsletter),
    };
  }

  async updateEmailClassification(
    emailId: string,
    newClassification: string
  ): Promise<void> {
    await this.db.execute({
      sql: `UPDATE processed_emails
            SET classification = ?, processed_at = ?
            WHERE id = ?`,
      args: [newClassification, new Date().toISOString(), emailId],
    });
  }

  // ============ Newsletter Items ============

  async saveNewsletterItem(item: Omit<NewsletterItem, 'id' | 'createdAt'>): Promise<number> {
    const result = await this.db.execute({
      sql: `INSERT INTO newsletter_items
            (email_id, url, title, description, tier, topic_tag, confidence, reason,
             readwise_status, readwise_doc_id, retry_count, next_retry_after)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        item.emailId, item.url, item.title, item.description,
        item.tier, item.topicTag, item.confidence, item.reason,
        item.readwiseStatus, item.readwiseDocId, item.retryCount,
        item.nextRetryAfter,
      ],
    });
    return Number(result.lastInsertRowid);
  }

  async getNewsletterItemsByEmail(emailId: string): Promise<NewsletterItem[]> {
    const result = await this.db.execute({
      sql: "SELECT * FROM newsletter_items WHERE email_id = ? ORDER BY id",
      args: [emailId],
    });
    return result.rows.map((row) => this.mapNewsletterItem(row));
  }

  async getNewsletterItemsByDigest(digestId: number): Promise<NewsletterItem[]> {
    const result = await this.db.execute({
      sql: `SELECT ni.* FROM newsletter_items ni
            JOIN processed_emails pe ON ni.email_id = pe.id
            WHERE pe.digest_id = ?
            ORDER BY ni.id`,
      args: [digestId],
    });
    return result.rows.map((row) => this.mapNewsletterItem(row));
  }

  async getRetryableItems(): Promise<NewsletterItem[]> {
    const now = new Date().toISOString();
    const result = await this.db.execute({
      sql: `SELECT * FROM newsletter_items
            WHERE readwise_status = 'failed'
            AND retry_count < 10
            AND (next_retry_after IS NULL OR next_retry_after <= ?)
            ORDER BY id`,
      args: [now],
    });
    return result.rows.map((row) => this.mapNewsletterItem(row));
  }

  async updateNewsletterItemReadwise(
    itemId: number,
    status: ReadwiseStatus | null,
    docId: string | null,
    retryCount: number,
    nextRetryAfter: string | null
  ): Promise<void> {
    await this.db.execute({
      sql: `UPDATE newsletter_items
            SET readwise_status = ?, readwise_doc_id = ?, retry_count = ?, next_retry_after = ?
            WHERE id = ?`,
      args: [status, docId, retryCount, nextRetryAfter, itemId],
    });
  }

  async updateNewsletterItemTier(itemId: number, newTier: ItemTier): Promise<void> {
    await this.db.execute({
      sql: "UPDATE newsletter_items SET tier = ? WHERE id = ?",
      args: [newTier, itemId],
    });
  }

  async getNewsletterItem(itemId: number): Promise<NewsletterItem | null> {
    const result = await this.db.execute({
      sql: "SELECT * FROM newsletter_items WHERE id = ?",
      args: [itemId],
    });
    if (result.rows.length === 0) return null;
    return this.mapNewsletterItem(result.rows[0]);
  }

  private mapNewsletterItem(row: Record<string, unknown>): NewsletterItem {
    return {
      id: row.id as number,
      emailId: row.email_id as string,
      url: row.url as string,
      title: row.title as string | null,
      description: row.description as string | null,
      tier: row.tier as ItemTier,
      topicTag: row.topic_tag as string | null,
      confidence: row.confidence as number,
      reason: row.reason as string | null,
      readwiseStatus: row.readwise_status as ReadwiseStatus | null,
      readwiseDocId: row.readwise_doc_id as string | null,
      retryCount: row.retry_count as number,
      nextRetryAfter: row.next_retry_after as string | null,
      createdAt: row.created_at as string,
    };
  }

  // ============ Tier Corrections ============

  async saveTierCorrection(correction: Omit<TierCorrection, 'id' | 'createdAt'>): Promise<number> {
    const result = await this.db.execute({
      sql: `INSERT INTO tier_corrections (item_id, original_tier, corrected_tier)
            VALUES (?, ?, ?)`,
      args: [correction.itemId, correction.originalTier, correction.correctedTier],
    });
    return Number(result.lastInsertRowid);
  }

  async getRecentTierCorrections(limit: number = 20): Promise<(TierCorrection & { itemUrl: string; itemTitle: string | null; newsletterFrom: string })[]> {
    const result = await this.db.execute({
      sql: `SELECT tc.*, ni.url as item_url, ni.title as item_title, pe.from_email as newsletter_from
            FROM tier_corrections tc
            JOIN newsletter_items ni ON tc.item_id = ni.id
            JOIN processed_emails pe ON ni.email_id = pe.id
            ORDER BY tc.created_at DESC
            LIMIT ?`,
      args: [limit],
    });
    return result.rows.map((row) => ({
      id: row.id as number,
      itemId: row.item_id as number,
      originalTier: row.original_tier as ItemTier,
      correctedTier: row.corrected_tier as ItemTier,
      createdAt: row.created_at as string,
      itemUrl: row.item_url as string,
      itemTitle: row.item_title as string | null,
      newsletterFrom: row.newsletter_from as string,
    }));
  }

  // ============ Correction Tokens ============

  async createCorrectionToken(digestId: number, expiryDays: number = 7): Promise<string> {
    const token = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000);
    await this.db.execute({
      sql: `INSERT INTO correction_tokens (token, digest_id, created_at, expires_at)
            VALUES (?, ?, ?, ?)`,
      args: [token, digestId, now.toISOString(), expiresAt.toISOString()],
    });
    return token;
  }

  async validateCorrectionToken(token: string): Promise<{ valid: boolean; digestId: number | null }> {
    const result = await this.db.execute({
      sql: "SELECT * FROM correction_tokens WHERE token = ?",
      args: [token],
    });
    if (result.rows.length === 0) return { valid: false, digestId: null };
    const row = result.rows[0];
    const expiresAt = new Date(row.expires_at as string);
    if (expiresAt < new Date()) return { valid: false, digestId: null };
    return { valid: true, digestId: row.digest_id as number };
  }

  // ============ Newsletter Stats ============

  // ============ Reading Feedback ============

  async saveReadingFeedback(feedback: Omit<ReadingFeedback, 'id' | 'createdAt' | 'processed'>): Promise<number> {
    const result = await this.db.execute({
      sql: `INSERT INTO reading_feedback
            (item_id, readwise_doc_id, signal_type, reading_progress, highlighted_text, event_timestamp)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        feedback.itemId, feedback.readwiseDocId, feedback.signalType,
        feedback.readingProgress, feedback.highlightedText, feedback.eventTimestamp,
      ],
    });
    return Number(result.lastInsertRowid);
  }

  async getUnprocessedFeedback(): Promise<ReadingFeedback[]> {
    const result = await this.db.execute(
      "SELECT * FROM reading_feedback WHERE processed = 0 ORDER BY event_timestamp"
    );
    return result.rows.map((row) => ({
      id: row.id as number,
      itemId: row.item_id as number,
      readwiseDocId: row.readwise_doc_id as string | null,
      signalType: row.signal_type as FeedbackSignal,
      readingProgress: row.reading_progress as number | null,
      highlightedText: row.highlighted_text as string | null,
      eventTimestamp: row.event_timestamp as string,
      processed: Boolean(row.processed),
      createdAt: row.created_at as string,
    }));
  }

  async markFeedbackProcessed(feedbackId: number): Promise<void> {
    await this.db.execute({
      sql: "UPDATE reading_feedback SET processed = 1 WHERE id = ?",
      args: [feedbackId],
    });
  }

  async getItemByReadwiseDocId(docId: string): Promise<NewsletterItem | null> {
    const result = await this.db.execute({
      sql: "SELECT * FROM newsletter_items WHERE readwise_doc_id = ?",
      args: [docId],
    });
    if (result.rows.length === 0) return null;
    return this.mapNewsletterItem(result.rows[0]);
  }

  async getItemsForProgressCheck(): Promise<NewsletterItem[]> {
    // Items saved to Readwise 7-30 days ago, not yet checked for reading progress
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.db.execute({
      sql: `SELECT ni.* FROM newsletter_items ni
            WHERE ni.readwise_status = 'saved'
            AND ni.readwise_doc_id IS NOT NULL
            AND ni.created_at BETWEEN ? AND ?
            AND ni.id NOT IN (
              SELECT DISTINCT item_id FROM reading_feedback
              WHERE signal_type = 'progress_update'
            )
            ORDER BY ni.created_at DESC
            LIMIT 50`,
      args: [thirtyDaysAgo, sevenDaysAgo],
    });
    return result.rows.map((row) => this.mapNewsletterItem(row));
  }

  async getFeedbackSummary(sinceDays: number = 30): Promise<{
    totalHighlights: number;
    totalFinished: number;
    highlightsByTier: Record<string, number>;
    highlightsByTopic: Record<string, number>;
    unreadMustReads: number;
    readNiceToHaves: number;
  }> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

    const highlights = await this.db.execute({
      sql: `SELECT ni.tier, ni.topic_tag, COUNT(*) as count
            FROM reading_feedback rf
            JOIN newsletter_items ni ON rf.item_id = ni.id
            WHERE rf.signal_type = 'highlight_created'
            AND rf.event_timestamp >= ?
            GROUP BY ni.tier, ni.topic_tag`,
      args: [since],
    });

    const finished = await this.db.execute({
      sql: `SELECT COUNT(*) as count FROM reading_feedback
            WHERE signal_type = 'document_finished' AND event_timestamp >= ?`,
      args: [since],
    });

    // Items saved as must-read but never opened after 14 days
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const unreadMustReads = await this.db.execute({
      sql: `SELECT COUNT(*) as count FROM newsletter_items ni
            WHERE ni.tier = 'must-read'
            AND ni.readwise_status = 'saved'
            AND ni.created_at <= ?
            AND ni.id NOT IN (
              SELECT DISTINCT item_id FROM reading_feedback
              WHERE signal_type IN ('highlight_created', 'document_finished', 'progress_update')
            )`,
      args: [fourteenDaysAgo],
    });

    // Items saved as nice-to-have that got read/highlighted
    const readNiceToHaves = await this.db.execute({
      sql: `SELECT COUNT(DISTINCT ni.id) as count FROM newsletter_items ni
            JOIN reading_feedback rf ON rf.item_id = ni.id
            WHERE ni.tier = 'nice-to-have'
            AND rf.signal_type IN ('highlight_created', 'document_finished')
            AND rf.event_timestamp >= ?`,
      args: [since],
    });

    let totalHighlights = 0;
    const highlightsByTier: Record<string, number> = {};
    const highlightsByTopic: Record<string, number> = {};
    for (const row of highlights.rows) {
      const count = row.count as number;
      const tier = row.tier as string;
      const topic = row.topic_tag as string;
      totalHighlights += count;
      highlightsByTier[tier] = (highlightsByTier[tier] || 0) + count;
      highlightsByTopic[topic] = (highlightsByTopic[topic] || 0) + count;
    }

    return {
      totalHighlights,
      totalFinished: finished.rows[0].count as number,
      highlightsByTier,
      highlightsByTopic,
      unreadMustReads: unreadMustReads.rows[0].count as number,
      readNiceToHaves: readNiceToHaves.rows[0].count as number,
    };
  }

  async getNewsletterStats(digestId: number): Promise<{
    newslettersProcessed: number;
    itemsExtracted: number;
    itemsByTier: Record<string, number>;
    itemsSaved: number;
    itemsFailed: number;
    itemsAbandoned: number;
  }> {
    const newsletters = await this.db.execute({
      sql: "SELECT COUNT(*) as count FROM processed_emails WHERE digest_id = ? AND is_newsletter = 1",
      args: [digestId],
    });

    const items = await this.db.execute({
      sql: `SELECT ni.tier, ni.readwise_status, COUNT(*) as count
            FROM newsletter_items ni
            JOIN processed_emails pe ON ni.email_id = pe.id
            WHERE pe.digest_id = ?
            GROUP BY ni.tier, ni.readwise_status`,
      args: [digestId],
    });

    let itemsExtracted = 0;
    let itemsSaved = 0;
    let itemsFailed = 0;
    let itemsAbandoned = 0;
    const itemsByTier: Record<string, number> = {};

    for (const row of items.rows) {
      const count = row.count as number;
      const tier = row.tier as string;
      const status = row.readwise_status as string | null;
      itemsExtracted += count;
      itemsByTier[tier] = (itemsByTier[tier] || 0) + count;
      if (status === "saved") itemsSaved += count;
      if (status === "failed") itemsFailed += count;
      if (status === "abandoned") itemsAbandoned += count;
    }

    return {
      newslettersProcessed: newsletters.rows[0].count as number,
      itemsExtracted,
      itemsByTier,
      itemsSaved,
      itemsFailed,
      itemsAbandoned,
    };
  }

}
