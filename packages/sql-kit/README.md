# @sethucms/adapter-sql-kit

Shared pieces for SQL adapters: dialects (PostgreSQL, MySQL, SQLite), parameterised query builders, `CREATE TABLE` from a collection definition, row normalising and the `SqlClient` interface. Not an adapter by itself.

Values are always parameters. Identifiers come only from introspection or a collection definition, must be plain names, and are quoted per dialect. `LIKE` wildcards in user text are escaped.

Settings, limits and test status: `sethucms-docs/docs/18-adapters.md`. Wrap the adapter in a `GuardedAdapter` (from `@sethucms/adapter-sdk`) before using it. Licence: MIT.
