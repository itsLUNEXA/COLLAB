import { describe, it, expect } from 'vitest';
import { threeWayMerge } from '../merge.js';

describe('merge.ts - Three-Way Line Merge Engine', () => {
  it('Task 2 & Criteria 1: Merges non-overlapping edits automatically without loss', () => {
    const base = [
      'function app() {',
      '  // header',
      '  const header = "Welcome";',
      '',
      '  // footer',
      '  const footer = "Copyright 2026";',
      '}',
    ].join('\n');

    // Local (Maheen) modifies header only
    const local = [
      'function app() {',
      '  // header',
      '  const header = "Welcome to Collaborative AI Platform";',
      '',
      '  // footer',
      '  const footer = "Copyright 2026";',
      '}',
    ].join('\n');

    // Remote (Shivam) modifies footer only
    const remote = [
      'function app() {',
      '  // header',
      '  const header = "Welcome";',
      '',
      '  // footer',
      '  const footer = "Copyright 2026 Hackathon Team";',
      '}',
    ].join('\n');

    const result = threeWayMerge(base, local, remote);
    expect(result.clean).toBe(true);
    expect(result.hasConflicts).toBe(false);
    expect(result.mergedContent).toContain('Welcome to Collaborative AI Platform');
    expect(result.mergedContent).toContain('Copyright 2026 Hackathon Team');
  });

  it('Task 3 & Criteria 2: Overlapping edits on the same lines are detected as conflicts with markers', () => {
    const base = 'const API_URL = "http://localhost:3000";';
    const local = 'const API_URL = "http://staging.api.com";';
    const remote = 'const API_URL = "https://prod.api.com";';

    const result = threeWayMerge(base, local, remote);
    expect(result.clean).toBe(false);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictChunks.length).toBeGreaterThan(0);
    expect(result.mergedContent).toContain('<<<<<<< LOCAL');
    expect(result.mergedContent).toContain('const API_URL = "http://staging.api.com";');
    expect(result.mergedContent).toContain('=======');
    expect(result.mergedContent).toContain('const API_URL = "https://prod.api.com";');
    expect(result.mergedContent).toContain('>>>>>>> REMOTE');
  });

  it('Criteria 1: Identical edits made concurrently by both peers merge cleanly', () => {
    const base = 'let count = 0;';
    const local = 'let count = 10;';
    const remote = 'let count = 10;';

    const result = threeWayMerge(base, local, remote);
    expect(result.clean).toBe(true);
    expect(result.mergedContent).toBe('let count = 10;');
  });

  it('Handles deletion vs modification conflicts', () => {
    const base = ['line 1', 'line 2 to remove', 'line 3'].join('\n');
    const local = ['line 1', 'line 3'].join('\n'); // Deleted line 2
    const remote = ['line 1', 'line 2 modified by remote', 'line 3'].join('\n'); // Modified line 2

    const result = threeWayMerge(base, local, remote);
    expect(result.clean).toBe(false);
    expect(result.hasConflicts).toBe(true);
  });
});
