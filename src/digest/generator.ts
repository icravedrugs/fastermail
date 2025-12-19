import Anthropic from "@anthropic-ai/sdk";
import type { Store, ProcessedEmail } from "../db/index.js";
import type { JMAPClient } from "../jmap/index.js";
import { applySummaryStrategy, requiresEmailBody, type DigestItem } from "./strategies.js";
import type { ExtractedLink } from "./link-extractor.js";

export interface DigestConfig {
  anthropicApiKey: string;
  userEmail: string;
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

  async generateDigest(sinceTimestamp: string): Promise<Digest | null> {
    // Get processed emails since last digest
    const emails = await this.store.getProcessedEmailsSince(sinceTimestamp);

    // Filter to only archived/low-priority emails
    const digestEmails = emails.filter(
      (e) =>
        e.classification === "low-priority" ||
        e.classification === "fyi" ||
        e.actionTaken === "archived"
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

    for (const [category, emails] of Object.entries(grouped)) {
      if (emails.length === 0) continue;

      const items = await this.summarizeGroup(category, emails);
      sections.push({
        title: this.formatCategoryTitle(category),
        items,
      });
    }

    // Generate HTML and text bodies
    const htmlBody = this.generateHtml(sections);
    const textBody = this.generateText(sections);

    // Save digest record
    const digestId = await this.store.saveDigest(digestEmails.length, textBody);

    return {
      id: digestId,
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

  private generateHtml(sections: DigestSection[]): string {
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
  <div style="text-align: center; margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
    Generated by Fastermail
  </div>
</body>
</html>`;
  }

  private generateText(sections: DigestSection[]): string {
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

    return `# Your Email Digest
${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

${sectionText}

---
Generated by Fastermail`;
  }

  async sendDigest(digest: Digest): Promise<void> {
    const draftId = await this.jmap.createDraft({
      to: [{ email: this.config.userEmail }],
      subject: `Email Digest - ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      textBody: digest.textBody,
      htmlBody: digest.htmlBody,
    });

    await this.jmap.sendEmail(draftId);
    await this.store.markDigestSent(digest.id);

    console.log(`Digest sent with ${digest.totalEmails} emails`);
  }
}
