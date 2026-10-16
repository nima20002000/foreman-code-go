import type pg from 'pg'

/** Records the most ci_runs heap pages any single transaction of the wrapped reads touched. */
export function measuredCiPages(pool: pg.Pool) {
  const pages = { max: 0 }
  const measured = { connect: async () => {
    const client = await pool.connect()
    return {
      async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]) {
        const result = await client.query<R>(text, values)
        try {
          const read = (await client.query<{ pages: number }>(
            "select pg_stat_get_xact_blocks_fetched('ci_runs'::regclass)::integer as pages")).rows[0]!.pages
          pages.max = Math.max(pages.max, read)
        } catch { /* ignore: a failed transaction already fails the measured read */ }
        return result
      },
      on: client.on.bind(client),
      removeListener: client.removeListener.bind(client),
      release: client.release.bind(client),
    }
  } } as unknown as pg.Pool
  return { pool: measured, pages }
}
