/**
 * Tracks email ids that Fastermail itself recently mutated, so the activity
 * watcher can attribute observed changes to `fastermail` instead of `user`.
 * The window covers push latency plus the polling fallback interval.
 */
export class SelfActionRegistry {
  private readonly touched = new Map<string, number>();

  constructor(private readonly windowMs = 180_000) {}

  record(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) {
      this.touched.set(id, now);
    }

    if (this.touched.size > 5000) {
      this.prune(now);
    }
  }

  wasRecentlyTouched(id: string): boolean {
    const at = this.touched.get(id);
    if (at === undefined) return false;

    if (Date.now() - at > this.windowMs) {
      this.touched.delete(id);
      return false;
    }
    return true;
  }

  private prune(now: number): void {
    for (const [id, at] of this.touched) {
      if (now - at > this.windowMs) {
        this.touched.delete(id);
      }
    }
  }
}
