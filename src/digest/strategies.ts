import Anthropic from "@anthropic-ai/sdk";
import type { ProcessedEmail, ContentFormat } from "../db/index.js";
import type { Email } from "../jmap/index.js";
import { extractLinksWithContext, type ExtractedLink } from "./link-extractor.js";

export interface DigestItem {
  emailId: string;
  threadId: string;
  from: string;
  subject: string;
  summary: string;
  links?: ExtractedLink[];
  contentFormat?: ContentFormat;
}

/**
 * Get the text content from an email body
 */
function getEmailBodyText(email: Email): string {
  if (!email.bodyValues) return email.preview || "";

  // Try to get text body first
  if (email.textBody) {
    for (const part of email.textBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        return email.bodyValues[part.partId].value;
      }
    }
  }

  // Fall back to HTML stripped of tags
  if (email.htmlBody) {
    for (const part of email.htmlBody) {
      if (part.partId && email.bodyValues[part.partId]) {
        const html = email.bodyValues[part.partId].value;
        // Basic HTML to text conversion
        return html
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }

  return email.preview || "";
}

/**
 * Get the HTML content from an email body
 */
function getEmailBodyHtml(email: Email): string | null {
  if (!email.bodyValues || !email.htmlBody) return null;

  for (const part of email.htmlBody) {
    if (part.partId && email.bodyValues[part.partId]) {
      return email.bodyValues[part.partId].value;
    }
  }

  return null;
}

/**
 * Apply the standard summarization strategy
 * Uses the content summary for actual email content
 */
function applyStandardStrategy(
  processedEmail: ProcessedEmail
): DigestItem {
  // Use contentSummary (actual content), fall back to reasoning only if needed
  const summary = processedEmail.contentSummary || processedEmail.reasoning || "No summary available";

  return {
    emailId: processedEmail.id,
    threadId: processedEmail.threadId || processedEmail.id,
    from: processedEmail.fromName || processedEmail.fromEmail,
    subject: processedEmail.subject || "(no subject)",
    summary,
    contentFormat: processedEmail.contentFormat,
  };
}

/**
 * Apply the link_collection strategy
 * Extracts story links from the email body with context/descriptions
 */
function applyLinkCollectionStrategy(
  processedEmail: ProcessedEmail,
  emailBody: Email | null
): DigestItem {
  let links: ExtractedLink[] = [];

  if (emailBody) {
    const html = getEmailBodyHtml(emailBody);
    if (html) {
      // Use extractLinksWithContext to get links with descriptions
      links = extractLinksWithContext(html).slice(0, 10);
    }
  }

  // Use contentSummary for the overview, not generic "X stories/links"
  const summary = processedEmail.contentSummary || processedEmail.reasoning || "Newsletter with curated links";

  return {
    emailId: processedEmail.id,
    threadId: processedEmail.threadId || processedEmail.id,
    from: processedEmail.fromName || processedEmail.fromEmail,
    subject: processedEmail.subject || "(no subject)",
    summary,
    links,
    contentFormat: processedEmail.contentFormat,
  };
}

/**
 * Apply the article strategy
 * Uses contentSummary or Claude to generate a brief prose summary
 */
async function applyArticleStrategy(
  processedEmail: ProcessedEmail,
  emailBody: Email | null,
  client: Anthropic
): Promise<DigestItem> {
  // Prefer contentSummary if available (already generated during classification)
  let summary = processedEmail.contentSummary || "";

  // Only call Claude if we don't have a contentSummary and have email body
  if (!summary && emailBody) {
    const bodyText = getEmailBodyText(emailBody);
    if (bodyText.length > 100) {
      try {
        const response = await client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 150,
          messages: [
            {
              role: "user",
              content: `Summarize this article/essay in 1-2 sentences. Focus on the main argument or takeaway.

Title: ${processedEmail.subject || "Unknown"}
Content: ${bodyText.slice(0, 2000)}

Respond with just the summary, no preamble.`,
            },
          ],
        });

        const text = response.content[0].type === "text" ? response.content[0].text : "";
        if (text) {
          summary = text.trim();
        }
      } catch (error) {
        console.error("Failed to summarize article:", error);
      }
    }
  }

  // Final fallback
  if (!summary) {
    summary = processedEmail.reasoning || "Article content";
  }

  return {
    emailId: processedEmail.id,
    threadId: processedEmail.threadId || processedEmail.id,
    from: processedEmail.fromName || processedEmail.fromEmail,
    subject: processedEmail.subject || "(no subject)",
    summary,
    contentFormat: processedEmail.contentFormat,
  };
}

/**
 * Apply the announcement strategy
 * Brief one-liner about the announcement
 */
function applyAnnouncementStrategy(
  processedEmail: ProcessedEmail
): DigestItem {
  // Use contentSummary for actual announcement content
  const summary = processedEmail.contentSummary || processedEmail.reasoning || "Announcement";

  return {
    emailId: processedEmail.id,
    threadId: processedEmail.threadId || processedEmail.id,
    from: processedEmail.fromName || processedEmail.fromEmail,
    subject: processedEmail.subject || "(no subject)",
    summary: summary.length > 150 ? summary.slice(0, 150) + "..." : summary,
    contentFormat: processedEmail.contentFormat,
  };
}

/**
 * Apply the transactional strategy
 * Extracts key details like amount, date, status
 */
function applyTransactionalStrategy(
  processedEmail: ProcessedEmail,
  emailBody: Email | null
): DigestItem {
  // Start with contentSummary if available
  let summary = processedEmail.contentSummary || "";

  // Try to extract key details from the email to supplement or create summary
  if (emailBody) {
    const text = getEmailBodyText(emailBody);
    const details: string[] = [];

    // Look for amounts
    const amountMatch = text.match(/\$[\d,]+\.?\d*/);
    if (amountMatch) {
      details.push(amountMatch[0]);
    }

    // Look for order/confirmation numbers
    const orderMatch = text.match(/(?:order|confirmation|tracking)[#:\s]*([A-Z0-9-]+)/i);
    if (orderMatch) {
      details.push(`#${orderMatch[1]}`);
    }

    // Look for dates
    const dateMatch = text.match(/(?:date|on|scheduled)[:\s]*([\w\s,]+\d{1,2}(?:st|nd|rd|th)?[,\s]+\d{4})/i);
    if (dateMatch) {
      details.push(dateMatch[1].trim());
    }

    // Use extracted details if no contentSummary, or append to contentSummary
    if (details.length > 0) {
      const detailsStr = details.join(" | ");
      summary = summary ? `${summary} (${detailsStr})` : detailsStr;
    }
  }

  // Final fallback
  if (!summary) {
    summary = processedEmail.reasoning || "Transaction/confirmation";
  }

  return {
    emailId: processedEmail.id,
    threadId: processedEmail.threadId || processedEmail.id,
    from: processedEmail.fromName || processedEmail.fromEmail,
    subject: processedEmail.subject || "(no subject)",
    summary,
    contentFormat: processedEmail.contentFormat,
  };
}

/**
 * Apply the appropriate summarization strategy based on content format
 */
export async function applySummaryStrategy(
  processedEmail: ProcessedEmail,
  emailBody: Email | null,
  client: Anthropic
): Promise<DigestItem> {
  const format = processedEmail.contentFormat || "standard";

  switch (format) {
    case "link_collection":
      return applyLinkCollectionStrategy(processedEmail, emailBody);

    case "article":
      return await applyArticleStrategy(processedEmail, emailBody, client);

    case "announcement":
      return applyAnnouncementStrategy(processedEmail);

    case "transactional":
      return applyTransactionalStrategy(processedEmail, emailBody);

    case "standard":
    default:
      return applyStandardStrategy(processedEmail);
  }
}

/**
 * Check if a content format requires fetching the full email body
 */
export function requiresEmailBody(format: ContentFormat): boolean {
  return format === "link_collection" || format === "article" || format === "transactional";
}
