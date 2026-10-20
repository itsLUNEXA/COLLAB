import { describe, it, expect } from 'vitest';
import {
  normalizeRelativePath,
  isPathEligibleForSync,
  isInternalDiagnosticPath,
  ErrorCode,
  CollabError,
} from '../index.js';

describe('paths.ts - Normalization & Path Jail Security', () => {
  it('should normalize Windows backslashes to POSIX slashes', () => {
    expect(normalizeRelativePath('src\\auth\\login.ts')).toBe('src/auth/login.ts');
    expect(normalizeRelativePath('a\\b\\c\\d.json')).toBe('a/b/c/d.json');
  });

  it('should strip redundant leading slashes', () => {
    expect(normalizeRelativePath('/src/index.ts')).toBe('src/index.ts');
    expect(normalizeRelativePath('///src/index.ts')).toBe('src/index.ts');
  });

  it('should reject directory traversal (..) with PATH_TRAVERSAL_DETECTED', () => {
    expect(() => normalizeRelativePath('../secret.env')).toThrowError(CollabError);
    expect(() => normalizeRelativePath('src/../../etc/passwd')).toThrowError(CollabError);
    try {
      normalizeRelativePath('../secret.env');
    } catch (err) {
      expect((err as CollabError).code).toBe(ErrorCode.PATH_TRAVERSAL_DETECTED);
    }
  });

  it('should reject Windows absolute drive letters', () => {
    expect(() => normalizeRelativePath('C:\\Windows\\System32\\cmd.exe')).toThrowError(CollabError);
    try {
      normalizeRelativePath('D:secret.txt');
    } catch (err) {
      expect((err as CollabError).code).toBe(ErrorCode.PATH_TRAVERSAL_DETECTED);
    }
  });

  it('should reject prohibited null bytes', () => {
    expect(() => normalizeRelativePath('src/auth\0.ts')).toThrowError(CollabError);
    try {
      normalizeRelativePath('test\0');
    } catch (err) {
      expect((err as CollabError).code).toBe(ErrorCode.INVALID_PATH_CHARACTERS);
    }
  });

  it('should correctly filter out secrets and non-syncable files (Safeguard 5)', () => {
    expect(isPathEligibleForSync('.env')).toBe(false);
    expect(isPathEligibleForSync('.env.local')).toBe(false);
    expect(isPathEligibleForSync('.env.production')).toBe(false);
    expect(isPathEligibleForSync('secrets/cert.pem')).toBe(false);
    expect(isPathEligibleForSync('id_rsa')).toBe(false);
    expect(isPathEligibleForSync('.git/config')).toBe(false);
    expect(isPathEligibleForSync('node_modules/express/index.js')).toBe(false);
    expect(isPathEligibleForSync('dist/bundle.js')).toBe(false);

    // Regular files should be allowed
    expect(isPathEligibleForSync('src/auth/login.ts')).toBe(true);
    expect(isPathEligibleForSync('frontend/App.tsx')).toBe(true);
    expect(isPathEligibleForSync('README.md')).toBe(true);
  });

  it('should identify internal diagnostic and loopback files (Safeguard 8)', () => {
    expect(isInternalDiagnosticPath('.collab/state.json')).toBe(true);
    expect(isInternalDiagnosticPath('.collab-internal/queue.db')).toBe(true);
    expect(isInternalDiagnosticPath('.agents/diagnostics/errors.json')).toBe(true);
    expect(isInternalDiagnosticPath('src/api.ts.collab-remote-105')).toBe(true);
    expect(isInternalDiagnosticPath('src/api.ts.conflict.remote')).toBe(true);

    expect(isInternalDiagnosticPath('src/auth/login.ts')).toBe(false);
  });
});
