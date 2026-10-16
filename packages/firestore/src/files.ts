/**
 * Small files (images, PDFs) kept in the customer's own Firestore.
 *
 * A Firestore document holds at most 1 MiB, so a file is cut into parts of
 * PART_BYTES and each part is its own document. The file's description is saved
 * last, so a reader never sees a half-written file. Both collections start with
 * "_sethucms_" and are therefore hidden from content.
 *
 *   _sethucms_files/<id>             { name, contentType, size, sha256, parts, createdAt }
 *   _sethucms_file_parts/<id>_<n>    { data }
 *
 * The id is random (128 bits) and is the only thing that makes a file link
 * hard to guess. Reading re-checks size and checksum, so a damaged file is
 * reported instead of served.
 */
import { createHash, randomBytes } from 'node:crypto';
import { errors } from '@sethucms/core';

export const FILES = '_sethucms_files';
export const FILE_PARTS = '_sethucms_file_parts';
/** Size of one stored part; well under Firestore's 1 MiB document limit. */
export const PART_BYTES = 700_000;
/** Largest file accepted. Serverless hosts cap a request at about 4.5 MB. */
export const MAX_FILE_BYTES = 4_000_000;
const MAX_PARTS = Math.ceil(MAX_FILE_BYTES / PART_BYTES);

/** What is kept about a stored file (never the bytes). */
export interface FileMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
  /** "private" files are only served to signed-in callers. Missing means public. */
  access: 'public' | 'private';
}

/** Ids are 22 URL-safe characters (16 random bytes). Anything else is "no such file". */
export const isFileId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);

const clean = (text: string, max: number): string =>
  // Control characters out, so a name cannot break a header or a log line.
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** Save a file. Returns its description, including the new id. */
export async function saveFile(
  db: any,
  input: { name: string; contentType: string; access?: 'public' | 'private' },
  data: Uint8Array,
): Promise<FileMeta> {
  if (data.byteLength === 0) {
    throw errors.validation('The file is empty');
  }
  if (data.byteLength > MAX_FILE_BYTES) {
    throw errors.validation(
      `The file is too large (the limit is ${MAX_FILE_BYTES / 1_000_000} MB)`,
    );
  }
  const name = clean(input.name, 255) || 'file';
  const contentType = clean(input.contentType, 100);
  if (!contentType) {
    throw errors.validation('The file type is missing');
  }
  const id = randomBytes(16).toString('base64url');
  const meta: FileMeta = {
    id,
    name,
    contentType,
    size: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
    createdAt: new Date().toISOString(),
    access: input.access === 'private' ? 'private' : 'public',
  };
  const parts = Math.ceil(data.byteLength / PART_BYTES);
  const written: string[] = [];
  try {
    await Promise.all(
      Array.from({ length: parts }, async (_, n) => {
        const partId = `${id}_${n}`;
        await db
          .collection(FILE_PARTS)
          .doc(partId)
          .create({
            data: Buffer.from(
              data.subarray(n * PART_BYTES, (n + 1) * PART_BYTES),
            ),
          });
        written.push(partId);
      }),
    );
    // The description goes in last: once it exists the file is complete.
    await db
      .collection(FILES)
      .doc(id)
      .create({
        name,
        contentType,
        size: meta.size,
        sha256: meta.sha256,
        parts,
        createdAt: meta.createdAt,
        access: meta.access,
      });
  } catch (error) {
    // Do not leave orphan parts behind.
    await Promise.allSettled(
      written.map((partId) => db.collection(FILE_PARTS).doc(partId).delete()),
    );
    throw error;
  }
  return meta;
}

/** The description of a stored file, or null when there is none. */
export async function loadFileMeta(
  db: any,
  id: string,
): Promise<(FileMeta & { parts: number }) | null> {
  if (!isFileId(id)) {
    return null;
  }
  const snapshot = await db.collection(FILES).doc(id).get();
  if (!snapshot.exists) {
    return null;
  }
  const raw = snapshot.data() as Record<string, unknown>;
  const parts = raw['parts'];
  if (
    typeof raw['name'] !== 'string' ||
    typeof raw['contentType'] !== 'string' ||
    typeof raw['size'] !== 'number' ||
    typeof raw['sha256'] !== 'string' ||
    typeof raw['createdAt'] !== 'string' ||
    typeof parts !== 'number' ||
    !Number.isInteger(parts) ||
    parts < 1 ||
    parts > MAX_PARTS
  ) {
    throw errors.internal('A stored file description is damaged');
  }
  return {
    id,
    name: raw['name'],
    contentType: raw['contentType'],
    size: raw['size'],
    sha256: raw['sha256'],
    createdAt: raw['createdAt'],
    // Files saved before this field existed are public, as they always were.
    access: raw['access'] === 'private' ? 'private' : 'public',
    parts,
  };
}

/** The bytes of a file, checked against its size and checksum. */
export async function loadFileBytes(
  db: any,
  meta: FileMeta & { parts: number },
): Promise<Buffer> {
  const pieces = await Promise.all(
    Array.from({ length: meta.parts }, async (_, n) => {
      const snapshot = await db
        .collection(FILE_PARTS)
        .doc(`${meta.id}_${n}`)
        .get();
      const stored = snapshot.exists ? snapshot.data()['data'] : undefined;
      if (!(stored instanceof Uint8Array)) {
        throw errors.internal('A stored file is incomplete');
      }
      return Buffer.from(stored);
    }),
  );
  const bytes = Buffer.concat(pieces);
  if (
    bytes.byteLength !== meta.size ||
    createHash('sha256').update(bytes).digest('hex') !== meta.sha256
  ) {
    throw errors.internal('A stored file is damaged');
  }
  return bytes;
}

/** Remove a file and its parts. Returns false when there was no such file. */
export async function removeFile(db: any, id: string): Promise<boolean> {
  if (!isFileId(id)) {
    return false;
  }
  const snapshot = await db.collection(FILES).doc(id).get();
  if (!snapshot.exists) {
    return false;
  }
  const parts = snapshot.data()['parts'];
  // The description first, so the file stops being served at once.
  await db.collection(FILES).doc(id).delete();
  const count =
    typeof parts === 'number' && Number.isInteger(parts)
      ? Math.min(Math.max(parts, 0), MAX_PARTS)
      : MAX_PARTS;
  await Promise.all(
    Array.from({ length: count }, (_, n) =>
      db.collection(FILE_PARTS).doc(`${id}_${n}`).delete(),
    ),
  );
  return true;
}
