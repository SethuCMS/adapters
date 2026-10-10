# @sethucms/adapter-firestore

Firestore adapter. Needs `@google-cloud/firestore` (peer dependency).

```ts
const adapter = new FirestoreAdapter();
await adapter.connect({ connectionId: "c1", config: { projectId: "my-project" }, credentials: { serviceAccount: "<key json>" }, readOnly: true });
```

Queries Firestore cannot run are refused, not approximated. **Experimental: tested only against an in-memory fake**, never against Firestore or the emulator.

Settings, limits and test status: `sethucms-docs/docs/18-adapters.md`. Wrap the adapter in a `GuardedAdapter` (from `@sethucms/adapter-sdk`) before using it. Licence: MIT.
