/**
 * A SqlClient that talks to PostgreSQL through the `psql` command line tool.
 *
 * It exists so the live tests can run on a machine that has Postgres but not
 * the `pg` npm package. Parameters are sent with psql's `\bind`, which uses
 * the real extended protocol, so statements are parameterised exactly as with
 * `pg`. Test use only.
 */
import { spawnSync } from 'node:child_process';
import type { SqlClient, SqlResult } from '../../src/index.js';

/** Create a psql-backed client for the given connection URL. */
export function createPsqlClient(url: string): SqlClient {
  const run = (script: string, extraArgs: string[] = []) => {
    const result = spawnSync(
      'psql',
      [url, '-v', 'ON_ERROR_STOP=1', '-q', '-At', ...extraArgs],
      { input: script, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      // psql prints the SQLSTATE in different forms depending on settings.
      const code =
        /SQLSTATE\s*[:=]?\s*(\w{5})/.exec(result.stderr)?.[1] ??
        /ERROR:\s+(\w{5})/.exec(result.stderr)?.[1];
      throw Object.assign(new Error(result.stderr.trim()), {
        code: code ?? 'XX000',
      });
    }
    return result.stdout;
  };

  return {
    async query(text, values = []): Promise<SqlResult> {
      // Row-returning statements are wrapped to come back as one JSON value.
      const returnsRows = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i.test(
        text,
      );
      if (!returnsRows) {
        run(text);
        return { rows: [] };
      }
      // json_agg turns the result set into JSON so types survive the text
      // round trip; the wrapped statement is still the original, parameterised.
      const wrapped = `WITH q AS (${text}) SELECT coalesce(json_agg(q), '[]'::json) FROM q`;
      // psql reads backslashes inside quoted arguments as escapes, so they are
      // doubled here. \bind passes every value as text; Postgres casts them.
      const quote = (value: unknown) =>
        `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
      const args = values.map(quote).join(' ');
      const out = run(
        `\\set VERBOSITY sqlstate\n${wrapped}\n\\bind ${args}\n\\g\n`,
      );
      return {
        rows: JSON.parse(out.trim() || '[]') as Array<Record<string, unknown>>,
      };
    },
    async close() {},
  };
}
