# sethucms-adapters

First-party database adapters for [SethuCMS](https://github.com/sethucms/sethucms).

![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![MySQL](https://img.shields.io/badge/MySQL-4479A1?style=flat-square&logo=mysql&logoColor=white) ![MariaDB](https://img.shields.io/badge/MariaDB-003545?style=flat-square&logo=mariadb&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white) ![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=flat-square&logo=mongodb&logoColor=white) ![Firestore](https://img.shields.io/badge/Firestore-FFCA28?style=flat-square&logo=firebase&logoColor=black)

<sub>Logos are trademarks of their owners and appear only to name the databases SethuCMS works with.</sub>

| Package | What it is | Status |
|---|---|---|
| [`packages/memory`](packages/memory) | In-memory reference adapter. For tests, demos and as a template. | Ready |
| [`packages/postgres`](packages/postgres) | PostgreSQL adapter (parameterized SQL, TLS on, read-only by default). | Tested on PostgreSQL 16 |
| [`packages/sql-kit`](packages/sql-kit) | Shared SQL dialects, builders and table creation used by the three SQL adapters. | Tested |
| [`packages/sqlite`](packages/sqlite) | SQLite files inside one allowed folder. Needs Node 22.5+. | Tested on real SQLite |
| [`packages/mysql`](packages/mysql) | MySQL / MariaDB. | Tested on MySQL 8 and MariaDB 11 |
| [`packages/mongodb`](packages/mongodb) | MongoDB (sampled or declared shapes). | Tested on MongoDB 7 |
| [`packages/firestore`](packages/firestore) | Firestore. | Tested on the Firestore emulator. Experimental |

"Tested on" means the real server (or Google's emulator for Firestore), run in CI. Run the live tests against your own server before relying on one (see below and `sethucms-docs/docs/18-adapters.md`). SQL Server and DynamoDB are not started.

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
