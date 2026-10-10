# @sethucms/adapter-sqlite

SQLite adapter using Node's built-in `node:sqlite` (Node 22.5 or newer).

```ts
const adapter = new SqliteAdapter({ baseDir: "/data/sqlite" });
await adapter.connect({ connectionId: "c1", config: { path: "site.db" }, credentials: {}, readOnly: false });
```

Files are accepted only inside `baseDir` (the gateway sets it from `SETHUCMS_SQLITE_DIR`). Without `baseDir` only `:memory:` works.

Settings, limits and test status: `sethucms-docs/docs/18-adapters.md`. Wrap the adapter in a `GuardedAdapter` (from `@sethucms/adapter-sdk`) before using it. Licence: MIT.
