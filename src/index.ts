import { config } from "dotenv";
config();

// Render ignores render.yaml envVars for this dashboard-created service, so
// pin the schedule zone in code: digest times mean Europe/London wall clock.
// Must run before anything constructs a Date.
if (!process.env.TZ) {
  process.env.TZ = "Europe/London";
}

import http from "http";
import { JMAPClient } from "./jmap/index.js";
import { createDbClient, initializeDatabase, Store } from "./db/index.js";
import { ProfileManager } from "./sender/index.js";
import { TriageEngine, LabelManager } from "./triage/index.js";
import { DigestScheduler } from "./digest/index.js";
import { runCleanup } from "./cleanup/index.js";
import { ActivityWatcher, SelfActionRegistry } from "./events/index.js";
import { verifyActionToken } from "./signing.js";
import { GITHUB_SENDER } from "./triage/pretriage.js";

// Shown when an action link fails signature verification. The common cause is
// a digest sent before 2026-08-19, when links were unsigned.
function legacyLinkPage(): string {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><title>Link Expired</title></head>
    <body style="font-family: sans-serif; max-width: 600px; margin: 50px auto; text-align: center;">
      <h1>This link no longer works</h1>
      <p>Quick-action links are now signed for security, so links in digests
      sent before <strong>19 August 2026</strong> can't be used anymore.</p>
      <p style="color: #666;">Links in every digest from that date onward work
      normally. For older digests, the "I'm Done &mdash; Archive Emails" button
      still works, or act on the email directly in Fastmail.</p>
    </body>
    </html>
  `;
}

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

  // Tag our own JMAP mutations so the activity watcher can tell them apart
  // from the user's actions.
  const selfActions = new SelfActionRegistry();
  jmap.onEmailMutation = (ids) => selfActions.record(ids);

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

  // Start triage engine
  console.log("\nStarting triage engine...");
  await triageEngine.start();

  // Start digest scheduler
  digestScheduler.start();

  // Start activity watcher (account-wide behavioral event capture)
  const activityWatcher = new ActivityWatcher(jmap, store, selfActions, pollInterval);
  try {
    await activityWatcher.start();
  } catch (error) {
    console.error("Activity watcher failed to start:", error);
  }

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
        // Record the cleanup click as a digest-level engagement event
        try {
          const digest = await store.getDigestByToken(token);
          if (digest) {
            await store.recordEvent({
              emailId: null,
              type: "digest_click",
              source: "user",
              detail: { action: "cleanup", digest_id: digest.id },
            });
          }
        } catch (err) {
          console.error("Failed to record cleanup click event:", err);
        }

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
      const scope = url.searchParams.get("scope") === "thread" ? "thread" : "";
      const token = url.searchParams.get("t");

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

      if (!verifyActionToken(["email-action", emailId, op, scope], token)) {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end(legacyLinkPage());
        return;
      }

      try {
        // scope=thread moves the GitHub notifications the collapsed digest
        // row actually represented: same thread, same sender, same digest.
        // Never a human reply that threaded in, never messages from other
        // digests — only what the row's "(N messages)" advertised.
        let ids = [emailId];
        if (scope === "thread") {
          const clicked = await store.getProcessedEmail(emailId);
          if (clicked?.threadId) {
            const threadEmails = await store.getProcessedEmailsByThreadId(clicked.threadId);
            const represented = threadEmails.filter(
              (e) =>
                e.fromEmail.toLowerCase() === GITHUB_SENDER &&
                e.digestId === clicked.digestId
            );
            if (represented.length > 0) {
              ids = represented.map((e) => e.id);
            }
          }
        }

        // Record the click before any JMAP call: the click is the user's
        // verdict and stays valid even if the move below fails
        await store.recordEvent({
          emailId,
          type: "digest_click",
          source: "user",
          detail: {
            action: op,
            ...(scope === "thread" ? { scope, thread_size: ids.length } : {}),
          },
        });

        const role = op === "delete" ? "trash" : "inbox";
        const mailbox = await jmap.findMailboxByRole(role);
        if (!mailbox) {
          throw new Error(`${role} mailbox not found`);
        }

        if (scope === "thread") {
          const updates: Record<string, Record<string, unknown>> = {};
          for (const id of ids) {
            updates[id] = { mailboxIds: { [mailbox.id]: true } };
          }
          await jmap.batchUpdateEmails(updates);
        } else {
          await jmap.moveEmail(emailId, mailbox.id);
        }

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
    } else if (url.pathname === "/r" && req.method === "GET") {
      // Click-tracking redirect for digest links. The HMAC token binds the
      // exact (email, action, target) triple we minted at digest time, so
      // this is not an open redirect.
      const emailId = url.searchParams.get("id");
      const action = url.searchParams.get("a");
      const target = url.searchParams.get("u");
      const token = url.searchParams.get("t");

      if (
        !emailId ||
        !target ||
        !/^https?:\/\//i.test(target) ||
        (action !== "open-link" && action !== "open-thread")
      ) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Invalid redirect request");
        return;
      }

      if (!verifyActionToken(["r", emailId, action, target], token)) {
        res.writeHead(403, { "Content-Type": "text/html" });
        res.end(legacyLinkPage());
        return;
      }

      try {
        await store.recordEvent({
          emailId,
          type: "digest_click",
          source: "user",
          detail: { action, url: target },
        });
      } catch (err) {
        console.error("Failed to record digest click event:", err);
      }

      res.writeHead(302, { Location: target });
      res.end();
    } else if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          tz: process.env.TZ ?? "unset",
          localHour: new Date().getHours(),
        })
      );
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
    activityWatcher.stop();
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
