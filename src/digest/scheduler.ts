import { DigestGenerator, type DigestConfig } from "./generator.js";
import type { Store } from "../db/index.js";
import type { JMAPClient } from "../jmap/index.js";

export interface SchedulerConfig extends DigestConfig {
  digestTimes: string[]; // ["09:00", "18:00"]
}

export class DigestScheduler {
  private readonly generator: DigestGenerator;
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly jmap: JMAPClient,
    private readonly config: SchedulerConfig
  ) {
    this.generator = new DigestGenerator(store, jmap, config);
  }

  start(): void {
    if (this.running) {
      console.log("Digest scheduler already running");
      return;
    }

    this.running = true;
    this.scheduleDigests();
    console.log(
      `Digest scheduler started (times: ${this.config.digestTimes.join(", ")})`
    );
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
    console.log("Digest scheduler stopped");
  }

  private scheduleDigests(): void {
    const now = new Date();

    for (const timeStr of this.config.digestTimes) {
      const [hours, minutes] = timeStr.split(":").map(Number);

      if (isNaN(hours) || isNaN(minutes)) {
        console.error(`Invalid digest time: ${timeStr}`);
        continue;
      }

      // Calculate next occurrence
      const nextRun = new Date(now);
      nextRun.setHours(hours, minutes, 0, 0);

      // If time has passed today, schedule for tomorrow
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }

      const msUntilRun = nextRun.getTime() - now.getTime();

      console.log(
        `Next digest at ${timeStr} scheduled for ${nextRun.toLocaleString()}`
      );

      const timer = setTimeout(() => {
        this.runDigest();
        // Reschedule for next day
        this.scheduleDigestAt(timeStr);
      }, msUntilRun);

      this.timers.push(timer);
    }
  }

  private scheduleDigestAt(timeStr: string): void {
    if (!this.running) return;

    const [hours, minutes] = timeStr.split(":").map(Number);
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setDate(nextRun.getDate() + 1);
    nextRun.setHours(hours, minutes, 0, 0);

    const msUntilRun = nextRun.getTime() - now.getTime();

    const timer = setTimeout(() => {
      this.runDigest();
      this.scheduleDigestAt(timeStr);
    }, msUntilRun);

    this.timers.push(timer);
  }

  private async runDigest(): Promise<void> {
    console.log("Running scheduled digest...");

    try {
      // Get last digest time
      const lastDigest = await this.store.getLastDigest();
      const sinceTimestamp = lastDigest?.generatedAt || this.getDefaultSince();

      const digest = await this.generator.generateDigest(sinceTimestamp);

      if (digest) {
        await this.generator.sendDigest(digest);
      }
    } catch (error) {
      console.error("Failed to run digest:", error);
    }
  }

  private getDefaultSince(): string {
    // Default to 12 hours ago if no previous digest
    const since = new Date(Date.now() - 12 * 60 * 60 * 1000);
    return since.toISOString();
  }

  // Manual trigger for testing
  async triggerDigest(): Promise<void> {
    console.log("Manually triggering digest...");
    await this.runDigest();
  }
}
