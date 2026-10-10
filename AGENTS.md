# AGENTS.md — sethucms-adapters

First-party adapters (memory, postgres).

This repository is one part of SethuCMS. **Read `../sethucms/AGENTS.md` first** for the whole picture, the security rules that must not be broken, and the working agreements.

## Build and test

```sh
pnpm install && pnpm -r build && pnpm test  (live PostgreSQL: set SETHUCMS_TEST_PG_URL)
```

## Notes

Build core and adapter-sdk first. Use parameterised queries and quoted identifiers only; never build SQL from input. Never put database error text in a message that reaches a client.

## Always

- Run the tests for what you changed and say what you ran and what you could not run.
- Do not `git commit` or `git push` unless the owner asks.
- Never print or store a secret, token or password.
