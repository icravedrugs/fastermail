import { config } from "dotenv";
config();

import { JMAPClient } from "./jmap/index.js";
import { createDbClient, initializeDatabase, Store } from "./db/index.js";
import { ProfileManager } from "./sender/index.js";
import { TriageEngine } from "./triage/index.js";
import { DigestScheduler } from "./digest/index.js";

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

  console.log(`User email: ${userEmail}`);
  console.log(`Poll interval: ${pollInterval}s`);
  console.log(`Digest times: ${digestTimes.join(", ")}`);

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
    mode: "label-only", // Start in safe mode
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    pollIntervalSeconds: pollInterval,
  });

  await triageEngine.initialize();

  // Initialize digest scheduler
  const digestScheduler = new DigestScheduler(store, jmap, {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    userEmail,
    digestTimes,
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    triageEngine.stop();
    digestScheduler.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start triage engine
  console.log("\nStarting triage engine...");
  await triageEngine.start();

  // Start digest scheduler
  digestScheduler.start();

  console.log("\nFastermail is running! Press Ctrl+C to stop.\n");

  // Keep process alive
  await new Promise(() => {});
}

main().catch(console.error);
