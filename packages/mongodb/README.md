# @sethucms/adapter-mongodb

MongoDB adapter. Needs the `mongodb` package (peer dependency).

```ts
const adapter = new MongoAdapter();
await adapter.connect({ connectionId: "c1", config: { host: "cluster0.example.mongodb.net", srv: true, database: "app" }, credentials: { user: "cms", password: "..." }, readOnly: true });
```

Collection shapes are sampled from documents or declared in `config.collections`. Operators in user values are rejected. **Tested only against FerretDB 1.24**, not MongoDB.

Settings, limits and test status: `sethucms-docs/docs/18-adapters.md`. Wrap the adapter in a `GuardedAdapter` (from `@sethucms/adapter-sdk`) before using it. Licence: MIT.
