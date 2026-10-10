/**
 * Runs the shared conformance suite against the memory adapter, with full
 * capabilities and again with a deliberately limited capability set.
 */
import { test } from 'node:test';
import {
  defineConformanceSuite,
  conformanceCollection,
} from '@sethucms/adapter-sdk/testing';
import { PRESETS, defineCapabilities } from '@sethucms/core';
import { MemoryAdapter } from '../src/index.js';

// The memory adapter must pass the same suite as every real database.
defineConformanceSuite(test, {
  label: 'memory (full capabilities)',
  async prepare() {
    const adapter = new MemoryAdapter({ collections: [conformanceCollection] });
    await adapter.connect({
      connectionId: 'test',
      config: {},
      credentials: {},
      readOnly: false,
    });
    return { adapter };
  },
});

// Run again as a deliberately limited, DynamoDB-like database to prove
// refusals work (the guard layer must reject what the database cannot do).
defineConformanceSuite(test, {
  label: 'memory (limited, like DynamoDB)',
  async prepare() {
    const adapter = new MemoryAdapter({
      collections: [conformanceCollection],
      capabilities: defineCapabilities({ ...PRESETS.dynamodb }),
    });
    await adapter.connect({
      connectionId: 'test',
      config: {},
      credentials: {},
      readOnly: false,
    });
    return { adapter };
  },
});
