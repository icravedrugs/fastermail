import { config } from "dotenv";
config();

import http from "http";
import { JMAPClient } from "./jmap/index.js";
import { createDbClient, initializeDatabase, Store } from "./db/index.js";
import { ProfileManager } from "./sender/index.js";
import { TriageEngine, LabelManager } from "./triage/index.js";
import { DigestScheduler } from "./digest/index.js";
import { runCleanup } from "./cleanup/index.js";
import { ReadwiseClient } from "./readwise/index.js";
import { renderCorrectionsPage, renderCorrectionSuccess, renderTokenError } from "./newsletter/corrections-ui.js";
import { saveItemsToReadwise } from "./newsletter/sync.js";
import { processWebhookEvent } from "./newsletter/feedback.js";

function validateSettings(): void {
  const required = [
    { key: "TURSO_DATABASE_URL", value: process.env.TURSO_DATABASE_URL },
    { key: "JMAP_TOKEN", value: process.env.JMAP_TOKEN },
    { key: "ANTHROPIC_API_KEY", value: process.env.ANTHROPIC_API_KEY },
    { key: "USER_EMAIL", value: process.env.USER_EMAIL },
  ];

  const missing = required.filter((r) => !r.value);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.map((m) => m.key).join(", ")}`
    );
  }
}

async function main(): Promise<void> {
  console.log("Fastermail - AI Email Triage Agent");
  console.log("===================================\n");

  // Validate configuration
  try {
    validateSettings();
    console.log("Configuration validated");
  } catch (error) {
    console.error("Configuration error:", error);
    console.log("\nPlease set the required environment variables.");
    process.exit(1);
  }

  const userEmail = process.env.USER_EMAIL!;
  const pollInterval = parseInt(process.env.POLL_INTERVAL || "60", 10);
  const digestTimes = (process.env.DIGEST_TIMES || "09:00,18:00").split(",");
  const baseUrl = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
  const port = parseInt(process.env.PORT || "3000", 10);

  // Unique instance ID for debugging duplicate sends
  const instanceId = `${process.pid}-${Date.now()}`;

  console.log(`User email: ${userEmail}`);
  console.log(`Poll interval: ${pollInterval}s`);
  console.log(`Digest times: ${digestTimes.join(", ")}`);
  console.log(`Instance ID: ${instanceId}`);
  if (baseUrl) {
    console.log(`Base URL: ${baseUrl}`);
  }
  if (process.env.READWISE_TOKEN) {
    console.log("Readwise integration enabled");
  }
  if (process.env.READWISE_FORWARD_EMAIL) {
    console.log(`Readwise forward: ${process.env.READWISE_FORWARD_EMAIL}`);
  }
  console.log("Reader profile: ./reader-profile.md");

  // Initialize database
  const dbClient = createDbClient();
  await initializeDatabase(dbClient);
  const store = new Store(dbClient);
  console.log("\nDatabase initialized (Turso)");

  // Show stats
  const stats = await store.getEmailStats();
  console.log(`Processed emails: ${stats.total} (${stats.last24h} in last 24h)`);

  // Initialize JMAP client
  const jmap = new JMAPClient(
    process.env.JMAP_SESSION_URL || "https://api.fastmail.com/jmap/session",
    process.env.JMAP_TOKEN!
  );

  try {
    await jmap.connect();
    console.log("\nJMAP connection established");

    // List mailboxes to verify connection
    const mailboxes = await jmap.getMailboxes();
    console.log(`Found ${mailboxes.length} mailboxes`);

    const inbox = mailboxes.find((m) => m.role === "inbox");
    if (inbox) {
      console.log(`Inbox has ${inbox.totalEmails} emails (${inbox.unreadEmails} unread)`);
    }
  } catch (error) {
    console.error("JMAP connection failed:", error);
    process.exit(1);
  }

  // Initialize sender profile manager
  const profileManager = new ProfileManager(store, jmap, userEmail);

  // Analyze historical emails on first run
  const existingProfiles = await profileManager.getAllProfiles();
  if (existingProfiles.length === 0) {
    console.log("\nFirst run: analyzing historical sent emails...");
    await profileManager.analyzeHistoricalEmails(200);
  } else {
    console.log(`\nLoaded ${existingProfiles.length} sender profiles`);
  }

  // Initialize triage engine
  const triageEngine = new TriageEngine(jmap, store, profileManager, {
    mode: "label-only",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    pollIntervalSeconds: pollInterval,
    userEmail,
    readwiseToken: process.env.READWISE_TOKEN,
    readerProfilePath: "./reader-profile.md",
    readwiseForwardEmail: process.env.READWISE_FORWARD_EMAIL,
  });

  await triageEngine.initialize();

  // Initialize label manager for cleanup operations
  const labelManager = new LabelManager(jmap);
  await labelManager.initialize();

  // Initialize digest scheduler
  const digestScheduler = new DigestScheduler(store, jmap, {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    userEmail,
    digestTimes,
    baseUrl,
    instanceId,
  });

  // Initialize Readwise client for correction UI retroactive saves
  const readwise = process.env.READWISE_TOKEN ? new ReadwiseClient(process.env.READWISE_TOKEN) : null;

  // Start triage engine
  console.log("\nStarting triage engine...");
  await triageEngine.start();

  // Start digest scheduler
  digestScheduler.start();

  // Start HTTP server for cleanup endpoint
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (url.pathname === "/cleanup" && req.method === "GET") {
      const token = url.searchParams.get("token");

      if (!token) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Error</title></head>
          <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
            <h1>Missing Token</h1>
            <p>No cleanup token was provided.</p>
          </body>
          </html>
        `);
        return;
      }

      try {
        const result = await runCleanup(token, jmap, store, labelManager);

        if (!result.success) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>Error</title></head>
            <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
              <h1>Error</h1>
              <p>${result.error || "Unknown error"}</p>
            </body>
            </html>
          `);
          return;
        }

        if (result.alreadyCleaned) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta charset="utf-8"><title>Already Cleaned</title></head>
            <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
              <h1>Already Cleaned</h1>
              <p>This digest has already been cleaned up.</p>
            </body>
            </html>
          `);
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Cleanup Complete</title></head>
          <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
            <h1 style="color: #22c55e;">Cleanup Complete</h1>
            <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>${result.archived}</strong> emails archived</p>
              <p><strong>${result.kept}</strong> emails kept in inbox</p>
              ${result.deleted > 0 ? `<p><strong>${result.deleted}</strong> emails were already deleted</p>` : ""}
            </div>
            <p style="color: #666;">You can close this tab now.</p>
          </body>
          </html>
        `);
      } catch (err) {
        console.error("Cleanup error:", err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Error</title></head>
          <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
            <h1>Error</h1>
            <p>An error occurred while processing your request.</p>
          </body>
          </html>
        `);
      }
    } else if (url.pathname === "/email-action" && req.method === "GET") {
      const emailId = url.searchParams.get("id");
      const op = url.searchParams.get("op");

      if (!emailId || !op || (op !== "delete" && op !== "inbox")) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Error</title></head>
          <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
            <h1>Invalid Request</h1>
            <p>Missing or invalid parameters. Required: id and op (delete or inbox).</p>
          </body>
          </html>
        `);
        return;
      }

      try {
        const role = op === "delete" ? "trash" : "inbox";
        const mailbox = await jmap.findMailboxByRole(role);
        if (!mailbox) {
          throw new Error(`${role} mailbox not found`);
        }
        await jmap.moveEmail(emailId, mailbox.id);

        const label = op === "delete" ? "Deleted" : "Moved to Inbox";
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>${label}</title></head>
          <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
            <h1 style="color: #22c55e;">${label}</h1>
            <p style="color: #666;">You can close this tab.</p>
            <script>setTimeout(() => window.close(), 1500)</script>
          </body>
          </html>
        `);
      } catch (err) {
        console.error("Email action error:", err);
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><meta charset="utf-8"><title>Error</title></head>
          <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
            <h1>Error</h1>
            <p>Failed to ${op === "delete" ? "delete" : "move"} the email. It may have already been moved.</p>
          </body>
          </html>
        `);
      }
    } else if (url.pathname === "/corrections" && req.method === "GET") {
      const token = url.searchParams.get("token");
      if (!token) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderTokenError(false));
        return;
      }

      const validation = await store.validateCorrectionToken(token);
      if (!validation.valid) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderTokenError(true));
        return;
      }

      const items = await store.getNewsletterItemsByDigest(validation.digestId!);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderCorrectionsPage(items, token, baseUrl || `http://localhost:${port}`));

    } else if (url.pathname === "/corrections/update" && req.method === "GET") {
      const token = url.searchParams.get("token");
      const itemId = url.searchParams.get("item");
      const newTier = url.searchParams.get("tier");

      if (!token || !itemId || !newTier) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderTokenError(false));
        return;
      }

      const validation = await store.validateCorrectionToken(token);
      if (!validation.valid) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(renderTokenError(true));
        return;
      }

      const item = await store.getNewsletterItem(parseInt(itemId, 10));
      if (!item) {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>Item not found</body></html>");
        return;
      }

      const validTiers = ["must-read", "nice-to-have", "skip"];
      if (!validTiers.includes(newTier)) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body>Invalid tier</body></html>");
        return;
      }

      // Save correction
      await store.saveTierCorrection({
        itemId: item.id,
        originalTier: item.tier,
        correctedTier: newTier as any,
      });

      // Update the item's tier
      await store.updateNewsletterItemTier(item.id, newTier as any);

      // Retroactive Readwise action
      if (readwise) {
        if ((newTier === "must-read" || newTier === "nice-to-have") && item.readwiseStatus !== "saved") {
          // Promote: save to Readwise
          try {
            const result = await readwise.save({
              url: item.url,
              title: item.title || undefined,
              tags: [`tier:${newTier}`, item.topicTag ? `topic:${item.topicTag}` : ""].filter(Boolean),
              location: newTier === "must-read" ? "new" : "later",
              saved_using: "fastermail",
            });
            await store.updateNewsletterItemReadwise(item.id, "saved", result.id, 0, null);
          } catch (error) {
            console.error("Retroactive Readwise save failed:", error);
          }
        } else if ((newTier === "must-read" || newTier === "nice-to-have") && item.readwiseDocId) {
          // Tier-to-tier change: update location and tags in Readwise
          try {
            await readwise.update(item.readwiseDocId, {
              location: newTier === "must-read" ? "new" : "later",
              tags: [`tier:${newTier}`, item.topicTag ? `topic:${item.topicTag}` : ""].filter(Boolean),
            });
          } catch (error) {
            console.error("Readwise tier update failed:", error);
          }
        } else if (newTier === "skip" && item.readwiseDocId) {
          // Demote: delete from Readwise
          try {
            await readwise.delete(item.readwiseDocId);
            await store.updateNewsletterItemReadwise(item.id, null, null, 0, null);
          } catch (error) {
            console.error("Readwise delete failed:", error);
          }
        } else if (newTier === "skip" && item.readwiseStatus) {
          // Demote with no Readwise doc to delete (pending save that never landed,
          // or prior failure). Clear the stale status so it isn't retried.
          await store.updateNewsletterItemReadwise(item.id, null, null, 0, null);
        }
      }

      // Return JSON for inline fetch, HTML for direct navigation
      if (url.searchParams.get("json") === "1") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, item: item.id, tier: newTier }));
      } else {
        const updatedItem = { ...item, tier: newTier as any };
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderCorrectionSuccess(updatedItem, newTier, token, baseUrl || `http://localhost:${port}`));
      }

    } else if (url.pathname === "/webhooks/readwise" && req.method === "POST") {
      // Readwise webhook endpoint — receives reading events
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => { chunks.push(Buffer.from(chunk)); });
      req.on("end", async () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          if (!body || body.trim().length === 0) {
            // Readwise sends empty test pings — acknowledge them
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ processed: true, reason: "ping acknowledged" }));
            return;
          }
          const event = JSON.parse(body);
          console.log(`Readwise webhook: ${event.type || "unknown"}`);
          const result = await processWebhookEvent(event, store);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error("Webhook processing error:", err);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ processed: false, reason: "invalid payload" }));
        }
      });
      return;

    } else if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>Not Found</title></head>
        <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
          <h1>Not Found</h1>
          <p>The requested page was not found.</p>
        </body>
        </html>
      `);
    }
  });

  server.listen(port, () => {
    console.log(`HTTP server listening on port ${port}`);
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    triageEngine.stop();
    digestScheduler.stop();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("\nFastermail is running! Press Ctrl+C to stop.\n");

  // Keep process alive
  await new Promise(() => {});
}

main().catch(console.error);
