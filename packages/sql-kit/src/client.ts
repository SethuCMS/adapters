/**
 * The small slice of a database client that the SQL adapters need.
 *
 * Keeping it this narrow lets tests use a fake, and keeps each real driver
 * confined to one function.
 */
/** Result of one statement, in a shape common to every driver. */
export interface SqlResult {
  rows: Array<Record<string, unknown>>;
  /** Drivers without RETURNING (MySQL) report the generated key here. */
  insertId?: string | number;
  /** Rows matched by an UPDATE or DELETE. */
  affected?: number;
}

/** Minimal driver-agnostic client: run one statement, release resources. */
export interface SqlClient {
  /**
   * Run one statement. `values` are bound by the driver as parameters and are
   * never spliced into `text`; this is what prevents SQL injection.
   */
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  /** Release the connection or pool. */
  close(): Promise<void>;
}
