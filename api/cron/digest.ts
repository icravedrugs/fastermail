import type { VercelRequest, VercelResponse } from "@vercel/node";
import { initServices, verifyCronSecret } from "../lib/init.js";

export const config = {
  maxDuration: 60,
};

function getDefaultSince(): string {
  // Default to 12 hours ago if no previous digest
  const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
  return since.toISOString();
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET requests
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Verify cron secret
  if (!verifyCronSecret(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    console.log("Digest cron triggered");
    const services = await initServices();
    const { store, digestGenerator } = services;

    // Get last digest time
    const lastDigest = await store.getLastDigest();
    const sinceTimestamp = lastDigest?.generatedAt || getDefaultSince();

    console.log(`Generating digest for emails since ${sinceTimestamp}`);

    const digest = await digestGenerator.generateDigest(sinceTimestamp);

    if (!digest) {
      res.status(200).json({
        success: true,
        message: "No emails to include in digest",
        emailCount: 0,
      });
      return;
    }

    await digestGenerator.sendDigest(digest);

    res.status(200).json({
      success: true,
      digestId: digest.id,
      emailCount: digest.totalEmails,
      sections: digest.sections.map((s) => ({
        title: s.title,
        itemCount: s.items.length,
      })),
    });
  } catch (error) {
    console.error("Digest cron error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
