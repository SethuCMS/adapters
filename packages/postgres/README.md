# @sethucms/adapter-postgres

PostgreSQL adapter for SethuCMS.

```ts
import { PostgresAdapter } from '@sethucms/adapter-postgres';

const adapter = new PostgresAdapter();
await adapter.connect({
  connectionId: 'c1',
  config: { host: 'db.example.com', database: 'app', schema: 'public' }, // ssl defaults to on
  credentials: { user: 'cms_reader', password: '...' },
  readOnly: true,
});
```

Wrap it in a `GuardedAdapter` (from `@sethucms/adapter-sdk`) before using it.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `host`, `database` | required | |
| `port` | 5432 | |
| `schema` | `public` | Only this schema is introspected |
| `ssl` | `true` | Certificates are verified. Turn off only for local development |
| `maxConnections` | 5 | 1 to 20 |
| `statementTimeoutMs` | 15000 | Enforced by the database |

When `readOnly` is true the session also sets `default_transaction_read_only=on`, so the database itself refuses writes even if everything above it failed.
Give the database user the fewest privileges it needs.

## How it keeps SQL safe

- Values are never part of the SQL text. They are sent as parameters (`$1`, `$2`, ...).
- Table and column names come only from introspection, must be plain identifiers, and are quoted.
- Text search escapes `%`, `_` and `\` so users cannot inject wildcards.
- Database error messages are never forwarded; only the code is mapped to a platform error.

## Introspection

Reads `information_schema`. Tables are left out when they have no primary key, a composite primary key, or a name that is not a plain identifier (letters, digits, underscore). The same applies to columns. Columns with types that do not map cleanly (for example `tsvector`) become strings marked `lossy`. Foreign keys become `many_to_one` relations.

## Known limits (v0)

- Pagination uses an offset inside the signed cursor. It is correct and stable (the primary key is always the final sort), but deep pages are slower than keyset pagination. Keyset is the planned upgrade.
- No batch writes, transactions API, or realtime yet.
- Full-text search is not declared as supported.

## Tests

```sh
pnpm --filter @sethucms/adapter-postgres test
```

Unit tests need no database. To also run the shared conformance suite against a real server:

```sh
SETHUCMS_TEST_PG_URL=postgres://user:pass@localhost:5432/postgres pnpm --filter @sethucms/adapter-postgres test
```

Each run creates a temporary schema and drops it afterwards. Use a throwaway database.
