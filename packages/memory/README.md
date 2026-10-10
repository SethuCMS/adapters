# @sethucms/adapter-memory

Keeps records in memory. For gateway tests, demos, and as the smallest readable example of an adapter. Not for real data.

```ts
import { MemoryAdapter } from '@sethucms/adapter-memory';

const adapter = new MemoryAdapter({ collections: [posts] });
await adapter.connect({ connectionId: 'demo', config: {}, credentials: {}, readOnly: false });
```

Pass `capabilities` to pretend to be a more limited database (for example `PRESETS.dynamodb`) and check how the platform reacts.
It passes the full conformance suite, both with full capabilities and with DynamoDB-like limits.
