/**
 * Test double for SqlClient: records every statement and answers from a
 * script, so adapter tests need no database.
 */
import type { SqlClient, SqlResult } from '../../src/index.js';

/** One statement the fake client received. */
export interface RecordedCall {
  text: string;
  values: unknown[];
}

/** A SqlClient that records statements and answers from a script. */
export class FakeClient implements SqlClient {
  readonly calls: RecordedCall[] = [];
  closed = false;
  constructor(
    private readonly respond: (
      call: RecordedCall,
    ) => SqlResult | Error = () => ({ rows: [] }),
  ) {}

  async query(text: string, values: unknown[] = []): Promise<SqlResult> {
    const call = { text, values };
    this.calls.push(call);
    const answer = this.respond(call);
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Build an error shaped like a `pg` error (SQLSTATE in `code`). The default
 * message holds a "secret" so tests can prove it never leaks into results.
 */
export const pgError = (
  code: string,
  message = 'native message with secret host db.internal',
) => Object.assign(new Error(message), { code });
