import Anthropic from "@anthropic-ai/sdk";
import type { Store, ProcessedEmail } from "../db/index.js";
import type { JMAPClient } from "../jmap/index.js";
import { applySummaryStrategy, requiresEmailBody, type DigestItem } from "./strategies.js";
import type { ExtractedLink } from "./link-extractor.js";

export interface DigestConfig {
  anthropicApiKey: string;
  userEmail: string;
  baseUrl?: string; // For cleanup link (e.g., https://fastermail.onrender.com)
  instanceId?: string; // For debugging duplicate sends
}

export interface DigestSection {
  title: string;
  items: Array<{
    from: string;
    subject: string;
    summary: string;
    links?: ExtractedLink[];
  }>;
}

export interface Digest {
  id: number;
  cleanupToken: string | null;
  generatedAt: string;
  sections: DigestSection[];
  totalEmails: number;
  htmlBody: string;
  textBody: string;
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

    // Filter to only archived/low-priority emails
    // Also exclude emails from the user's own address (previous digests)
    const digestEmails = emails.filter(
      (e) =>
        (e.classification === "low-priority" ||
          e.classification === "fyi" ||
          e.actionTaken === "archived") &&
        e.fromEmail.toLowerCase() !== this.config.userEmail.toLowerCase()
    );

    if (digestEmails.length === 0) {
      console.log("No emails to include in digest");
      return null;
    }

    console.log(`Generating digest for ${digestEmails.length} emails...`);

    // Group emails by category/type
    const grouped = this.groupEmails(digestEmails);

    // Generate summaries for each group
    const sections: DigestSection[] = [];

    for (const [category, categoryEmails] of Object.entries(grouped)) {
      if (categoryEmails.length === 0) continue;

      const items = await this.summarizeGroup(category, categoryEmails);
      sections.push({
        title: this.formatCategoryTitle(category),
        items,
      });
    }

    // Generate HTML and text bodies with cleanup link
    const cleanupUrl = this.config.baseUrl && pendingDigest.cleanupToken
      ? `${this.config.baseUrl}/cleanup?token=${pendingDigest.cleanupToken}`
      : null;

    const htmlBody = this.generateHtml(sections, cleanupUrl);
    const textBody = this.generateText(sections, cleanupUrl);

    return {
      id: pendingDigest.id,
      cleanupToken: pendingDigest.cleanupToken,
      generatedAt: new Date().toISOString(),
      sections,
      totalEmails: digestEmails.length,
      htmlBody,
      textBody,
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
  ): Promise<Array<{ from: string; subject: string; summary: string; links?: ExtractedLink[] }>> {
    const results: Array<{ from: string; subject: string; summary: string; links?: ExtractedLink[] }> = [];

    for (const email of emails) {
      try {
        // Check if we need to fetch full email body for this content format
        let emailBody = null;
        if (requiresEmailBody(email.contentFormat)) {
          try {
            emailBody = await this.jmap.getEmailBody(email.id);
          } catch (error) {
            console.error(`Failed to fetch email body for ${email.id}:`, error);
          }
        }

        // Apply the appropriate strategy
        const item = await applySummaryStrategy(email, emailBody, this.client);
        results.push({
          from: item.from,
          subject: item.subject,
          summary: item.summary,
          links: item.links,
        });
      } catch (error) {
        console.error(`Failed to summarize email ${email.id}:`, error);
        // Fall back to basic summary
        results.push({
          from: email.fromName || email.fromEmail,
          subject: email.subject || "(no subject)",
          summary: email.reasoning || "No summary available",
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

  private generateHtml(sections: DigestSection[], cleanupUrl: string | null): string {
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
                (item) => `
              <li style="margin-bottom: 12px; padding: 12px; background: #f9f9f9; border-radius: 8px;">
                <div style="font-weight: 600; color: #333;">${item.subject}</div>
                <div style="font-size: 13px; color: #666; margin-top: 4px;">From: ${item.from}</div>
                <div style="font-size: 14px; color: #444; margin-top: 8px;">${item.summary}</div>
                ${item.links && item.links.length > 0 ? `
                <ul style="margin-top: 8px; padding-left: 16px; list-style: disc;">
                  ${item.links.map((link) => `
                    <li style="margin-bottom: 4px;">
                      <a href="${link.url}" style="color: #0066cc; text-decoration: none;">${link.title}</a>
                    </li>
                  `).join("")}
                </ul>
                ` : ""}
              </li>
            `
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

  private generateText(sections: DigestSection[], cleanupUrl: string | null): string {
    const sectionText = sections
      .filter((s) => s.items.length > 0)
      .map(
        (section) =>
          `## ${section.title} (${section.items.length})\n\n` +
          section.items
            .map((item) => {
              let text = `* ${item.subject}\n  From: ${item.from}\n  ${item.summary}`;
              if (item.links && item.links.length > 0) {
                text += "\n  Links:";
                for (const link of item.links) {
                  text += `\n    - ${link.title}: ${link.url}`;
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
    console.log(`[SEND_START] digest_id=${digest.id}, instance=${this.config.instanceId}`);

    const draftId = await this.jmap.createDraft({
      to: [{ email: this.config.userEmail }],
      subject: `Email Digest - ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      textBody: digest.textBody,
      htmlBody: digest.htmlBody,
    });

    await this.jmap.sendEmail(draftId);
    console.log(`[SEND_COMPLETE] digest_id=${digest.id}`);

    // Mark current digest as sent and create new pending digest for future emails
    await this.store.markDigestSent(digest.id, digest.totalEmails, digest.textBody);
    console.log(`[MARKED_SENT] digest_id=${digest.id}`);

    await this.store.createPendingDigest();

    console.log(`Digest sent with ${digest.totalEmails} emails`);
  }
}
