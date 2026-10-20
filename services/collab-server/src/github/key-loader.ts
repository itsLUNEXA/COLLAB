/**
 * @file key-loader.ts
 * Secure GitHub App RSA Private Key (PEM) file resolution and loader.
 * Guarantees zero secret leakage into logs or error messages (Safeguard 5).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves a private key path deterministically.
 * Searches relative to baseDir, repository root, or process.cwd().
 */
export function resolvePrivateKeyPath(keyPath: string, baseDir: string = process.cwd()): string {
  if (path.isAbsolute(keyPath)) {
    return path.normalize(keyPath);
  }

  // 1. Try directly relative to baseDir (e.g. repo root)
  const candidate1 = path.resolve(baseDir, keyPath);
  if (fs.existsSync(candidate1)) {
    return candidate1;
  }

  // 2. Try relative to monorepo root if baseDir is inside a package/service
  const candidate2 = path.resolve(baseDir, '..', '..', keyPath);
  if (fs.existsSync(candidate2)) {
    return candidate2;
  }

  // 3. Try relative to process.cwd()
  const candidate3 = path.resolve(process.cwd(), keyPath);
  if (fs.existsSync(candidate3)) {
    return candidate3;
  }

  // Fallback to primary candidate for clear error reporting
  return candidate1;
}

/**
 * Safely loads and validates an RSA private key PEM file without exposing its contents.
 */
export function loadPrivateKeyPem(keyPath: string, baseDir: string = process.cwd()): string {
  if (!keyPath || typeof keyPath !== 'string') {
    throw new Error('GitHub App private key path must be a non-empty string');
  }

  const resolvedPath = resolvePrivateKeyPath(keyPath, baseDir);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`GitHub App private key file not found at resolved path: ${resolvedPath}`);
  }

  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
  } catch {
    throw new Error(`GitHub App private key file exists but is not readable: ${resolvedPath}`);
  }

  const pem = fs.readFileSync(resolvedPath, 'utf8').trim();

  if (!pem.includes('PRIVATE KEY')) {
    throw new Error(`File at ${resolvedPath} does not appear to contain a valid RSA private key (missing PRIVATE KEY header)`);
  }

  return pem;
}
