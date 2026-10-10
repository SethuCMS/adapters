# sethucms-adapters

First-party database adapters for [SethuCMS](https://github.com/sethucms/sethucms).

| Package | What it is | Status |
|---|---|---|
| [`packages/memory`](packages/memory) | In-memory reference adapter. For tests, demos and as a template. | Ready |
| [`packages/postgres`](packages/postgres) | PostgreSQL adapter (parameterized SQL, TLS on, read-only by default). | Tested on PostgreSQL 16 |
| [`packages/sql-kit`](packages/sql-kit) | Shared SQL dialects, builders and table creation used by the three SQL adapters. | Tested |
| [`packages/sqlite`](packages/sqlite) | SQLite files inside one allowed folder. Needs Node 22.5+. | Tested on real SQLite |
| [`packages/mysql`](packages/mysql) | MySQL / MariaDB. | Tested only against Dolt |
| [`packages/mongodb`](packages/mongodb) | MongoDB (sampled or declared shapes). | Tested only against FerretDB 1.24 |
| [`packages/firestore`](packages/firestore) | Firestore. | Tested only against an in-memory fake. Experimental |

"Tested only against" means a compatible server or a fake, not the real product. Run the live tests against your own server before relying on one (see below and `sethucms-docs/docs/18-adapters.md`). SQL Server and DynamoDB are not started.

Every adapter must pass the conformance suite from
[`@sethucms/adapter-sdk`](https://github.com/sethucms/sethucms-adapter-sdk) before it is released.

## Working on it locally

These packages depend on `@sethucms/core` and `@sethucms/adapter-sdk`, which are not
published yet. Until they are, `package.json` links them from sibling folders, so clone
the three repos side by side:

```
~/sethucms/                 (core lives in packages/core; build it first)
~/sethucms-adapter-sdk/     (build it second)
~/sethucms-adapters/        (this repo)
```

```bash
(cd ../sethucms/packages/core && pnpm install && pnpm build)
(cd ../sethucms-adapter-sdk && pnpm install && pnpm build)
pnpm install
pnpm test
```

Once core and the SDK are published to npm, delete the `pnpm.overrides` block in the
root `package.json`; the `^0.0.0` ranges then resolve from the registry.

## Live database tests

Set `SETHUCMS_TEST_MYSQL_URL` (for example `mysql://root@127.0.0.1:3306`) or `SETHUCMS_TEST_MONGO_URL` (for example `mongodb://127.0.0.1:27017`) to run the MySQL and MongoDB live tests. They create and drop a scratch database. Use a throwaway server.

## Live PostgreSQL tests

The Postgres live tests skip unless you point them at a throwaway database:

```bash
SETHUCMS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres pnpm test
```

Never point this at a database with data you care about.
