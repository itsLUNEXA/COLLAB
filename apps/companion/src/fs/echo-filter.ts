/**
 * @file echo-filter.ts
 * Memory-bounded echo suppression filter.
 * Prevents incoming synchronized remote file writes from being echoed back to the server (Safeguard 8).
 */

export class EchoFilter {
  private suppressionMap = new Map<string, { hash: string; expiresAt: number }>();

  constructor(private ttlMs: number = 5000) {}

  /**
   * Registers a file path and expected hash before writing it to the local filesystem.
   */
  public registerRemoteWrite(relativePath: string, targetHash: string): void {
    const key = this.normalizeKey(relativePath);
    this.suppressionMap.set(key, {
      hash: targetHash,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Evaluates whether a local filesystem event should be suppressed.
   * If the event matches a pending remote write, returns true and removes the suppression entry.
   */
  public shouldSuppress(relativePath: string, currentHash: string): boolean {
    const key = this.normalizeKey(relativePath);
    const entry = this.suppressionMap.get(key);

    if (!entry) {
      return false;
    }

    if (Date.now() > entry.expiresAt) {
      this.suppressionMap.delete(key);
      return false;
    }

    if (entry.hash === currentHash) {
      // Exact match: this event was triggered by our own remote write applier!
      this.suppressionMap.delete(key);
      return true;
    }

    return false;
  }

  /**
   * Cleans expired suppression records.
   */
  public prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.suppressionMap.entries()) {
      if (now > entry.expiresAt) {
        this.suppressionMap.delete(key);
      }
    }
  }

  private normalizeKey(rawPath: string): string {
    return rawPath.replace(/\\/g, '/').toLowerCase();
  }
}
