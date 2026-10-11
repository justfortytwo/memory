// Child process for test/migrate-concurrency.test.ts: opens + migrates argv[2]
// in its own OS process (own SQLite connections). Prints `ready`, waits for a
// line on stdin (the parent's start barrier), then migrates and exits 0, or
// prints the error and exits 1.
import { openDb } from '../../src/db.js';
import { runMigrations } from '../../src/migrate.js';

const dbPath = process.argv[2];
process.stdout.write('ready\n');
process.stdin.once('data', async () => {
  try {
    const h = openDb(dbPath);
    await runMigrations(h.k);
    await h.k.destroy();
    h.raw.close();
    process.stdout.write('ok\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`${(e as Error).stack} code=${(e as { code?: string }).code}\n`);
    process.exit(1);
  }
});
