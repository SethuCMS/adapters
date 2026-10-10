/**
 * SQLite connection settings.
 *
 * A SQLite "connection" is a file on the gateway's disk, so the path is the
 * dangerous part: an administrator must not be able to point the gateway at
 * /etc or at another connection's data. Paths are therefore only accepted
 * inside one base folder chosen by whoever runs the gateway.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { errors } from '@sethucms/core';
import type { ConnectInput } from '@sethucms/adapter-sdk';

/** Validated settings with the final, safe database path. */
export interface SqliteSettings {
  /** ':memory:' or an absolute file path inside the base folder. */
  path: string;
  /** How long SQLite waits on a locked file before failing (SQLITE_BUSY). */
  busyTimeoutMs: number;
}

/**
 * Validate the connection config and resolve the database path.
 *
 * `baseDir` is the only folder file databases may live in; without it only
 * ':memory:' is accepted. Messages name the offending setting and never echo
 * the path value.
 */
export function parseSettings(
  input: ConnectInput,
  baseDir: string | undefined,
): SqliteSettings {
  const problems: string[] = [];
  const rawPath = input.config['path'];
  const busy = input.config['busyTimeoutMs'] ?? 5000;

  if (
    typeof busy !== 'number' ||
    !Number.isInteger(busy) ||
    busy < 0 ||
    busy > 60_000
  ) {
    problems.push('busyTimeoutMs');
  }

  // Checks run from cheapest/most obviously wrong to the containment test.
  // NUL bytes could truncate the path in C code, so they are refused.
  let path = '';
  if (
    typeof rawPath !== 'string' ||
    rawPath.length === 0 ||
    rawPath.length > 500 ||
    rawPath.includes('\0')
  ) {
    problems.push('path');
  } else if (rawPath === ':memory:') {
    path = rawPath;
  } else if (!baseDir) {
    problems.push(
      'path (file databases are not enabled on this gateway; set SETHUCMS_SQLITE_DIR)',
    );
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) && !isAbsolute(rawPath)) {
    // "file:..." style URIs can carry options (e.g. mode, vfs) and bypass the
    // folder check, so only plain paths are allowed.
    problems.push('path (URIs are not accepted)');
  } else {
    // Resolve first (collapsing "..", and absolute inputs), then require the
    // result to be strictly inside the base folder. Comparing the relative
    // path is safer than a string prefix check ("/data" vs "/data-evil").
    const base = resolve(baseDir);
    const full = resolve(base, rawPath);
    const inside = relative(base, full);
    if (
      inside === '' ||
      inside.startsWith('..') ||
      isAbsolute(inside) ||
      inside.split(sep).includes('..')
    ) {
      problems.push('path (must be a file inside the SQLite folder)');
    } else {
      path = full;
    }
  }

  if (problems.length > 0) {
    throw errors.validation(
      `Invalid SQLite connection settings: ${problems.join(', ')}`,
    );
  }
  return { path, busyTimeoutMs: busy as number };
}
