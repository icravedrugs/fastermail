import type { VercelRequest } from "@vercel/node";
import { createClient } from "@libsql/client";
import { initializeDatabase, Store } from "../../src/db/index.js";
import { JMAPClient } from "../../src/jmap/index.js";
import { ProfileManager } from "../../src/sender/index.js";
import { LabelManager } from "../../src/triage/labels.js";
import { CorrectionProcessor } from "../../src/triage/corrections.js";
import { EmailClassifier } from "../../src/triage/classifier.js";
import { DigestGenerator } from "../../src/digest/generator.js";

export interface Services {
  store: Store;
  jmap: JMAPClient;
  profileManager: ProfileManager;
  labelManager: LabelManager;
  correctionProcessor: CorrectionProcessor;
  classifier: EmailClassifier;
  digestGenerator: DigestGenerator;
  config: AppConfig;
}

export interface AppConfig {
  userEmail: string;
  mode: "label-only" | "triage";
  anthropicApiKey: string;
}

function validateEnv(): void {
  const required = [
    "TURSO_DATABASE_URL",
    "JMAP_TOKEN",
    "ANTHROPIC_API_KEY",
    "USER_EMAIL",
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

export function verifyCronSecret(req: VercelRequest): boolean {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  // In development, allow requests without secret
  if (!cronSecret) {
    return true;
  }

  return authHeader === `Bearer ${cronSecret}`;
}

let cachedServices: Services | null = null;

export async function initServices(): Promise<Services> {
  // Return cached services if available (warm Lambda)
  if (cachedServices) {
    return cachedServices;
  }

  validateEnv();

  const userEmail = process.env.USER_EMAIL!;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY!;
  const mode = (process.env.MODE as "label-only" | "triage") || "label-only";

  const config: AppConfig = {
    userEmail,
    mode,
    anthropicApiKey,
  };

  // Initialize database
  const dbClient = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  await initializeDatabase(dbClient);
  const store = new Store(dbClient);

  // Initialize JMAP client
  const jmap = new JMAPClient(
    process.env.JMAP_SESSION_URL || "https://api.fastmail.com/jmap/session",
    process.env.JMAP_TOKEN!
  );
  await jmap.connect();

  // Initialize managers
  const profileManager = new ProfileManager(store, jmap, userEmail);
  const labelManager = new LabelManager(jmap);
  await labelManager.initialize();

  const correctionProcessor = new CorrectionProcessor(
    jmap,
    store,
    labelManager,
    anthropicApiKey
  );
  await correctionProcessor.initialize();

  const classifier = new EmailClassifier(anthropicApiKey);

  const digestGenerator = new DigestGenerator(store, jmap, {
    anthropicApiKey,
    userEmail,
  });

  cachedServices = {
    store,
    jmap,
    profileManager,
    labelManager,
    correctionProcessor,
    classifier,
    digestGenerator,
    config,
  };

  return cachedServices;
}
