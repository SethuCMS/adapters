/**
 * Public entry point of the MongoDB adapter package: re-exports the adapter,
 * its client factory, settings parser, schema inference and query translators.
 */

export * from './mongo-adapter.js';
export {
  createMongoClient,
  type MongoClientFactory,
  type MongoHandle,
} from './client.js';
export { parseSettings, type MongoSettings } from './settings.js';
export { inferCollection } from './infer.js';
export {
  compileFilter,
  compileFind,
  escapeRegex,
  assertSafeJson,
} from './translate.js';
export { mapMongoError } from './errors.js';
