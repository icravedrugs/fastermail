import Anthropic from "@anthropic-ai/sdk";
import type { Store, ProcessedEmail } from "../db/index.js";
import type { JMAPClient } from "../jmap/index.js";
import { applySummaryStrategy, requiresEmailBody } from "./strategies.js";
import type { ExtractedLink } from "./link-extractor.js";
import { signActionToken } from "../signing.js";
import { GITHUB_SENDER } from "../triage/pretriage.js";

export interface DigestConfig {
  anthropicApiKey: string;
  userEmail: string;
  baseUrl?: string; // For cleanup link (e.g., https://fastermail.onrender.com)
  instanceId?: string; // For debugging duplicate sends
}

export interface DigestItem {
  emailId: string;
  threadId: string;
  from: string;
  subject: string;
  summary: string;
  links?: ExtractedLink[];
  // Number of thread messages this row represents (>1 = collapsed thread)
  threadCount?: number;
  // Email was routed to the inbox but keeps its digest row so the
  // rescue/delete signal survives — see docs/window-2-handoff.md Phase 1
  promoted?: boolean;
}

export interface DigestSection {
  title: string;
  items: DigestItem[];
}

export interface DigestInclusion {
  emailId: string;
  strategy: string;
  promoted: boolean;
  threadSize?: number;
}

export interface Digest {
  id: number;
  cleanupToken: string | null;
  generatedAt: string;
  sections: DigestSection[];
  totalEmails: number;
  htmlBody: string;
  textBody: string;
  // The rows actually rendered, captured at render time — digest_included
  // events are emitted from this, never from a post-send re-query
  included: DigestInclusion[];
  // Every email that belonged to this digest when rendering began; emails
  // triaged after this snapshot are reassigned to the next digest
  snapshotEmailIds: string[];
}

export class DigestGenerator {
  private readonly client: Anthropic;

  constructor(
    private readonly store: Store,
    private readonly jmap: JMAPClient,
    private readonly config: DigestConfig
  ) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  async generateDigest(_sinceTimestamp?: string): Promise<Digest | null> {
    // Get the current pending digest
    const pendingDigest = await this.store.getPendingDigest();

    // Get all emails associated with this digest
    const emails = await this.store.getEmailsByDigestId(pendingDigest.id);

    // Include ALL triaged emails in digest, except emails from the user's own address (previous digests)
    const digestEmails = emails.filter(
      (e) => e.fromEmail.toLowerCase() !== this.config.userEmail.toLowerCase()
    );

    if (digestEmails.length === 0) {
      console.log("No emails to include in digest");
      return null;
    }

    console.log(`Generating digest for ${digestEmails.length} emails...`);

    // Collapse GitHub PR notification threads to one row per thread (window 1:
    // 14% of digest rows were repeats of a thread already shown). The latest
    // message represents the thread; members stay associated with the digest.
    const threadSizes = new Map<string, number>(); // representative id -> thread size
    const collapsedEmails: ProcessedEmail[] = [];
    const seenGithubThreads = new Map<string, ProcessedEmail>();

    for (const email of digestEmails) {
      if (email.fromEmail.toLowerCase() === GITHUB_SENDER && email.threadId) {
        const existing = seenGithubThreads.get(email.threadId);
        // getEmailsByDigestId orders by received_at DESC, so first seen = latest
        if (existing) {
          threadSizes.set(existing.id, (threadSizes.get(existing.id) ?? 1) + 1);
          continue;
        }
        seenGithubThreads.set(email.threadId, email);
        threadSizes.set(email.id, 1);
      }
      collapsedEmails.push(email);
    }

    const promotedIds = new Set(
      digestEmails.filter((e) => e.actionTaken === "promoted").map((e) => e.id)
    );

    // Group emails by category/type
    const grouped = this.groupEmails(collapsedEmails);

    // Generate summaries for each group
    const sections: DigestSection[] = [];

    for (const [category, categoryEmails] of Object.entries(grouped)) {
      if (categoryEmails.length === 0) continue;

      const items = await this.summarizeGroup(category, categoryEmails);
      for (const item of items) {
        const size = threadSizes.get(item.emailId);
        if (size && size > 1) {
          item.threadCount = size;
        }
        // Inherited thread rows store internal reasoning as their fallback
        // summary — never show that placeholder to the user
        if (!item.summary || item.summary.startsWith("Thread continuation")) {
          item.summary =
            size && size > 1
              ? `${size} notifications in this thread`
              : "New activity in this thread";
        }
        if (promotedIds.has(item.emailId)) {
          item.promoted = true;
        }
      }
      sections.push({
        title: this.formatCategoryTitle(category),
        items,
      });
    }

    const included: DigestInclusion[] = collapsedEmails.map((e) => ({
      emailId: e.id,
      strategy: e.contentFormat,
      promoted: promotedIds.has(e.id),
      ...((threadSizes.get(e.id) ?? 1) > 1
        ? { threadSize: threadSizes.get(e.id) }
        : {}),
    }));

    // Generate HTML and text bodies with cleanup link
    const cleanupUrl = this.config.baseUrl && pendingDigest.cleanupToken
      ? `${this.config.baseUrl}/cleanup?token=${pendingDigest.cleanupToken}`
      : null;

    const htmlBody = this.generateHtml(sections, cleanupUrl, this.config.baseUrl);
    const textBody = this.generateText(sections, cleanupUrl, this.config.baseUrl);

    return {
      id: pendingDigest.id,
      cleanupToken: pendingDigest.cleanupToken,
      generatedAt: new Date().toISOString(),
      sections,
      totalEmails: digestEmails.length,
      htmlBody,
      textBody,
      included,
      snapshotEmailIds: emails.map((e) => e.id),
    };
  }

  private groupEmails(
    emails: ProcessedEmail[]
  ): Record<string, ProcessedEmail[]> {
    const groups: Record<string, ProcessedEmail[]> = {
      newsletters: [],
      notifications: [],
      receipts: [],
      updates: [],
      other: [],
    };

    for (const email of emails) {
      const labels = email.labelsApplied?.toLowerCase() || "";
      const subject = email.subject?.toLowerCase() || "";
      const from = email.fromEmail.toLowerCase();

      if (
        labels.includes("newsletter") ||
        from.includes("newsletter") ||
        subject.includes("newsletter")
      ) {
        groups.newsletters.push(email);
      } else if (
        labels.includes("notification") ||
        from.includes("noreply") ||
        from.includes("no-reply") ||
        from.includes("notification")
      ) {
        groups.notifications.push(email);
      } else if (
        labels.includes("receipt") ||
        subject.includes("receipt") ||
        subject.includes("invoice") ||
        subject.includes("payment")
      ) {
        groups.receipts.push(email);
      } else if (
        labels.includes("update") ||
        subject.includes("update") ||
        subject.includes("changes")
      ) {
        groups.updates.push(email);
      } else {
        groups.other.push(email);
      }
    }

    return groups;
  }

  private async summarizeGroup(
    category: string,
    emails: ProcessedEmail[]
  ): Promise<DigestItem[]> {
    const results: DigestItem[] = [];

    for (const email of emails) {
      try {
        let emailBody = null;
        if (requiresEmailBody(email.contentFormat)) {
          try {
            emailBody = await this.jmap.getEmailBody(email.id);
          } catch (error) {
            console.error(`Failed to fetch email body for ${email.id}:`, error);
          }
        }

        const item = await applySummaryStrategy(email, emailBody, this.client);

        results.push({
          emailId: item.emailId,
          threadId: item.threadId,
          from: item.from,
          subject: item.subject,
          summary: item.summary,
          links: item.links,
        });
      } catch (error) {
        console.error(`Failed to summarize email ${email.id}:`, error);
        // Fall back to basic summary
        results.push({
          emailId: email.id,
          threadId: email.threadId || email.id,
          from: email.fromName || email.fromEmail,
          subject: email.subject || "(no subject)",
          summary: email.contentSummary || email.reasoning || "No summary available",
        });
      }
    }

    return results;
  }

  private formatCategoryTitle(category: string): string {
    const titles: Record<string, string> = {
      newsletters: "Newsletters",
      notifications: "Notifications",
      receipts: "Receipts & Payments",
      updates: "Updates",
      other: "Other",
    };
    return titles[category] || category;
  }

  // Route outbound digest links through our own /r endpoint so every click
  // is recorded as a digest_click event before redirecting. Links are
  // HMAC-signed: these URLs live in the mailbox forever, and an unsigned /r
  // would be an open redirect.
  private trackUrl(
    emailId: string,
    url: string,
    action: "open-link" | "open-thread"
  ): string {
    if (!this.config.baseUrl) return url;
    const token = signActionToken(["r", emailId, action, url]);
    return `${this.config.baseUrl}/r?id=${encodeURIComponent(emailId)}&a=${action}&u=${encodeURIComponent(url)}&t=${token}`;
  }

  private actionUrl(emailId: string, op: "delete" | "inbox", scope: "" | "thread"): string {
    const token = signActionToken(["email-action", emailId, op, scope]);
    const scopeParam = scope ? `&scope=${scope}` : "";
    return `${this.config.baseUrl}/email-action?id=${encodeURIComponent(emailId)}&op=${op}${scopeParam}&t=${token}`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private generateHtml(sections: DigestSection[], cleanupUrl: string | null, baseUrl?: string): string {
    const sectionHtml = sections
      .filter((s) => s.items.length > 0)
      .map(
        (section) => `
        <div style="margin-bottom: 24px;">
          <h2 style="font-size: 18px; color: #333; margin-bottom: 12px; border-bottom: 1px solid #eee; padding-bottom: 8px;">
            ${section.title} (${section.items.length})
          </h2>
          <ul style="list-style: none; padding: 0; margin: 0;">
            ${section.items
              .map(
                (item) => {
                  const fastmailUrl = `https://app.fastmail.com/mail/Inbox/${item.threadId}.${item.emailId}`;
                  const isThread = (item.threadCount ?? 1) > 1;
                  const deleteLabel = isThread ? `[delete thread]` : `[delete]`;
                  const inboxLink = item.promoted
                    ? ""
                    : `<a href="${this.actionUrl(item.emailId, "inbox", "")}" style="color: #999; text-decoration: none; margin-left: 8px;">[inbox]</a>`;
                  const actionLinks = baseUrl ? `
                <div style="margin-top: 6px; font-size: 12px;">
                  <a href="${this.actionUrl(item.emailId, "delete", isThread ? "thread" : "")}" style="color: #999; text-decoration: none;">${deleteLabel}</a>
                  ${inboxLink}
                </div>` : "";
                  const threadBadge = isThread
                    ? ` <span style="color: #666; font-weight: 400; font-size: 13px;">(${item.threadCount} messages)</span>`
                    : "";
                  const promotedBadge = item.promoted
                    ? `<div style="margin-top: 4px;"><span style="font-size: 11px; color: #0a7d33; background: #e6f6ec; padding: 2px 8px; border-radius: 10px;">already in your inbox</span></div>`
                    : "";
                  return `
              <li style="margin-bottom: 12px; padding: 12px; background: #f9f9f9; border-radius: 8px;">
                <div style="font-weight: 600;">
                  <a href="${this.trackUrl(item.emailId, fastmailUrl, "open-thread")}" style="color: #333; text-decoration: none;">${this.escapeHtml(item.subject)}</a>${threadBadge}
                </div>
                ${promotedBadge}
                <div style="font-size: 13px; color: #666; margin-top: 4px;">From: ${this.escapeHtml(item.from)}</div>
                <div style="font-size: 14px; color: #444; margin-top: 8px;">${this.escapeHtml(item.summary)}</div>
                ${item.links && item.links.length > 0 ? `
                <div style="margin-top: 10px;">
                  ${item.links.map((link) => `
                    <div style="margin-top: 6px; padding-left: 12px; border-left: 2px solid #ddd;">
                      <a href="${this.trackUrl(item.emailId, link.url, "open-link")}" style="color: #0066cc; text-decoration: none;">${this.escapeHtml(link.title)}</a>
                      ${link.description ? `<div style="font-size: 13px; color: #666; margin-top: 2px;">${this.escapeHtml(link.description)}</div>` : ""}
                    </div>
                  `).join("")}
                </div>
                ` : ""}${actionLinks}
              </li>
            `;
                }
              )
              .join("")}
          </ul>
        </div>
      `
      )
      .join("");

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="text-align: center; margin-bottom: 24px;">
    <h1 style="font-size: 24px; margin: 0;">Your Email Digest</h1>
    <p style="color: #666; margin-top: 8px;">${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
  </div>
  ${sectionHtml}
  ${cleanupUrl ? `
  <div style="text-align: center; margin-top: 32px; padding: 20px; background: #f5f5f5; border-radius: 8px;">
    <p style="margin: 0 0 12px 0; color: #333; font-size: 14px;">Done reviewing? Click below to archive these emails.</p>
    <a href="${cleanupUrl}" style="display: inline-block; padding: 12px 24px; background: #0066cc; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">I'm Done - Archive Emails</a>
    <p style="margin: 12px 0 0 0; color: #666; font-size: 12px;">Emails you moved to your inbox will be kept.</p>
  </div>
  ` : ""}
  <div style="text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
    Generated by Fastermail${this.config.instanceId ? ` | Instance: ${this.config.instanceId}` : ""}
  </div>
</body>
</html>`;
  }

  private generateText(sections: DigestSection[], cleanupUrl: string | null, baseUrl?: string): string {
    const sectionText = sections
      .filter((s) => s.items.length > 0)
      .map(
        (section) =>
          `## ${section.title} (${section.items.length})\n\n` +
          section.items
            .map((item) => {
              const fastmailUrl = `https://app.fastmail.com/mail/Inbox/${item.threadId}.${item.emailId}`;
              const isThread = (item.threadCount ?? 1) > 1;
              const subjectSuffix = isThread ? ` (${item.threadCount} messages)` : "";
              const promotedNote = item.promoted ? "\n  [already in your inbox]" : "";
              let text = `* ${item.subject}${subjectSuffix}${promotedNote}\n  From: ${item.from}\n  ${item.summary}\n  View: ${fastmailUrl}`;
              if (item.links && item.links.length > 0) {
                text += "\n  Links:";
                for (const link of item.links) {
                  text += `\n    - ${link.title}: ${link.url}`;
                  if (link.description) {
                    text += `\n      ${link.description}`;
                  }
                }
              }
              if (baseUrl) {
                text += `\n  Actions: [delete${isThread ? " thread" : ""}] ${this.actionUrl(item.emailId, "delete", isThread ? "thread" : "")}`;
                if (!item.promoted) {
                  text += `\n           [inbox] ${this.actionUrl(item.emailId, "inbox", "")}`;
                }
              }
              return text;
            })
            .join("\n\n")
      )
      .join("\n\n---\n\n");

    const cleanupSection = cleanupUrl ? `

---

DONE REVIEWING?

Click to archive these emails (emails you moved to inbox will be kept):
${cleanupUrl}` : "";

    return `# Your Email Digest
${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

${sectionText}${cleanupSection}

---
Generated by Fastermail${this.config.instanceId ? ` | Instance: ${this.config.instanceId}` : ""}`;
  }

  async sendDigest(digest: Digest): Promise<void> {
    const draftId = await this.jmap.createDraft({
      to: [{ email: this.config.userEmail }],
      subject: `Email Digest - ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      textBody: digest.textBody,
      htmlBody: digest.htmlBody,
    });

    await this.jmap.sendEmail(draftId);

    // Mark current digest as sent and create new pending digest for future emails
    await this.store.markDigestSent(digest.id, digest.totalEmails, digest.textBody);
    const nextPending = await this.store.createPendingDigest();

    // Emails triaged while this digest was rendering/sending carry its id but
    // never appeared in it — hand them to the next digest instead of leaving
    // them orphaned on a sent one (and inflating the engagement denominator).
    try {
      const reassigned = await this.store.reassignDigestEmails(
        digest.id,
        nextPending.id,
        digest.snapshotEmailIds
      );
      if (reassigned > 0) {
        console.log(`Reassigned ${reassigned} late-triaged emails to digest ${nextPending.id}`);
      }
    } catch (err) {
      console.error("Failed to reassign late-triaged digest emails:", err);
    }

    // Record what this digest actually rendered — one event per rendered row,
    // captured at render time, so digest engagement has an honest denominator.
    try {
      for (const row of digest.included) {
        await this.store.recordEvent({
          emailId: row.emailId,
          type: "digest_included",
          source: "fastermail",
          detail: {
            digest_id: digest.id,
            strategy: row.strategy,
            ...(row.promoted ? { promoted: true } : {}),
            ...(row.threadSize ? { thread_size: row.threadSize } : {}),
          },
        });
      }
    } catch (err) {
      console.error("Failed to record digest_included events:", err);
    }

    console.log(`Digest sent with ${digest.totalEmails} emails (${digest.included.length} rows rendered)`);
  }
}
