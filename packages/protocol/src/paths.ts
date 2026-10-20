/**
 * @file paths.ts
 * Path normalization, path traversal prevention, and synchronization ignore filter rules.
 * Enforces Safeguards 5, 6, and 8.
 */

import { CollabError, ErrorCode } from './errors.js';

// Patterns that MUST NEVER be synchronized over the wire
export const DEFAULT_IGNORE_PATTERNS = [
  // Secrets & Environment Credentials (Safeguard 5)
  /^\.env(\..+)?$/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^.*\.pfx$/i,
  /^.*\.cert$/i,
  /^id_rsa.*$/i,

  // Version Control & Package Internals
  /^\.git(\/.*)?$/i,
  /^\.svn(\/.*)?$/i,
  /^node_modules(\/.*)?$/i,
  /^vendor(\/.*)?$/i,

  // Build Outputs & Cache
  /^dist(\/.*)?$/i,
  /^build(\/.*)?$/i,
  /^out(\/.*)?$/i,
  /^target(\/.*)?$/i,
  /^\.turbo(\/.*)?$/i,
  /^\.cache(\/.*)?$/i,

  // Platform Internal State & Diagnostics (Safeguard 8: Loop Prevention)
  /^\.collab(\/.*)?$/i,
  /^\.collab-internal(\/.*)?$/i,
  /^\.agents\/diagnostics(\/.*)?$/i,
  /^.*\.conflict\.remote.*$/i,
  /^.*\.collab-remote-.*$/i,
  /^.*\.tmp$/i,
  /^.*~$/i,
  /^\.DS_Store$/i,
  /^Thumbs\.db$/i,
];

/**
 * Normalizes a relative workspace path to a clean POSIX format.
 * Throws CollabError with PATH_TRAVERSAL_DETECTED or INVALID_PATH_CHARACTERS if invalid.
 *
 * @param rawPath - Raw path provided by local filesystem watcher or incoming sync event.
 * @returns Clean normalized POSIX path (e.g. "src/auth/login.ts").
 */
export function normalizeRelativePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new CollabError(ErrorCode.INVALID_PATH_CHARACTERS, 'Path must be a non-empty string');
  }

  // Reject null bytes immediately
  if (rawPath.includes('\0')) {
    throw new CollabError(ErrorCode.INVALID_PATH_CHARACTERS, 'Path contains prohibited null byte');
  }

  // Reject Windows drive letters (e.g., "C:\path" or "C:path")
  if (/^[a-zA-Z]:/.test(rawPath)) {
    throw new CollabError(
      ErrorCode.PATH_TRAVERSAL_DETECTED,
      'Absolute paths with drive letters are strictly prohibited',
      { rawPath }
    );
  }

  // Convert backslashes to forward slashes
  let normalized = rawPath.replace(/\\/g, '/');

  // Strip leading slashes to prevent absolute root reference
  normalized = normalized.replace(/^\/+/, '');

  // Split into segments and evaluate traversal
  const segments = normalized.split('/');
  const safeSegments: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      throw new CollabError(
        ErrorCode.PATH_TRAVERSAL_DETECTED,
        'Path contains directory traversal segment (..)',
        { rawPath }
      );
    }
    safeSegments.push(segment);
  }

  if (safeSegments.length === 0) {
    throw new CollabError(ErrorCode.INVALID_PATH_CHARACTERS, 'Path resolved to empty target', { rawPath });
  }

  return safeSegments.join('/');
}

/**
 * Checks whether a normalized relative path is eligible for live synchronization.
 * Returns true if the path is synchronized; false if it must be ignored.
 */
export function isPathEligibleForSync(normalizedPath: string): boolean {
  for (const pattern of DEFAULT_IGNORE_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns true if the path matches internal platform diagnostic or loopback files.
 * Used by companion appliers to avoid reacting to internal diagnostic writes (Safeguard 8).
 */
export function isInternalDiagnosticPath(normalizedPath: string): boolean {
  return (
    normalizedPath.startsWith('.collab/') ||
    normalizedPath.startsWith('.collab-internal/') ||
    normalizedPath.startsWith('.agents/diagnostics/') ||
    normalizedPath.includes('.collab-remote-') ||
    normalizedPath.includes('.conflict.remote')
  );
}
