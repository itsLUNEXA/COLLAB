import { describe, it, expect } from 'vitest';
import { EchoFilter } from '../fs/echo-filter.js';

describe('EchoFilter - Loop Prevention (Safeguard 8)', () => {
  it('should suppress a local watcher event if it matches a pending remote write', () => {
    const filter = new EchoFilter(5000);
    const path = 'backend/auth.ts';
    const hash = 'a'.repeat(64);

    filter.registerRemoteWrite(path, hash);

    // Watcher fires with exact matching hash
    const suppressed = filter.shouldSuppress(path, hash);
    expect(suppressed).toBe(true);

    // Second check should not suppress (consumed)
    const secondCheck = filter.shouldSuppress(path, hash);
    expect(secondCheck).toBe(false);
  });

  it('should not suppress if the content hash differs (concurrent local edit)', () => {
    const filter = new EchoFilter(5000);
    const path = 'backend/auth.ts';
    const remoteHash = 'a'.repeat(64);
    const localHash = 'b'.repeat(64);

    filter.registerRemoteWrite(path, remoteHash);

    const suppressed = filter.shouldSuppress(path, localHash);
    expect(suppressed).toBe(false);
  });

  it('should not suppress un-registered paths', () => {
    const filter = new EchoFilter(5000);
    expect(filter.shouldSuppress('frontend/App.tsx', 'c'.repeat(64))).toBe(false);
  });
});
