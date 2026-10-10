# @sethucms/adapter-mysql

MySQL and MariaDB adapter. Needs the `mysql2` package (peer dependency).

```ts
const adapter = new MysqlAdapter();
await adapter.connect({ connectionId: "c1", config: { host: "db.example.com", database: "app" }, credentials: { user: "cms", password: "..." }, readOnly: true });
```

TLS is on by default. **Tested only against Dolt**, not MySQL or MariaDB.

Settings, limits and test status: `sethucms-docs/docs/18-adapters.md`. Wrap the adapter in a `GuardedAdapter` (from `@sethucms/adapter-sdk`) before using it. Licence: MIT.
