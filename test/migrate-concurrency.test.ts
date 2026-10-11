import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

// Regression: Telegram and Scheduler both call openDb + runMigrations on the same
// fresh DB at startup. Each child here is an independent OS process with its own
// SQLite connections, released together through a stdin barrier.
const viteNode = resolve('node_modules/.bin/vite-node');
const child = resolve('test/fixtures/migrate-child.ts');

function spawnChild(dbPath: string): { proc: ChildProcess; ready: Promise<void>; done: Promise<{ code: number | null; stderr: string }> } {
  const proc = spawn(viteNode, [child, dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const ready = new Promise<void>((res, rej) => {
    proc.stdout!.on('data', (d) => {
      stdout += String(d);
      if (stdout.includes('ready\n')) res();
    });
    proc.once('exit', () => rej(new Error(`child exited before ready: ${stderr}`)));
  });
  proc.stderr!.on('data', (d) => (stderr += String(d)));
  const done = new Promise<{ code: number | null; stderr: string }>((res) =>
    proc.once('exit', (code) => res({ code, stderr })),
  );
  return { proc, ready, done };
}

describe('runMigrations under concurrent first-open', () => {
  it.each([2, 6])('lets %i independent processes migrate one absent DB concurrently', async (CHILDREN) => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mem-race-')), 'fortytwo.db');
    expect(existsSync(dbPath)).toBe(false);

    const kids = Array.from({ length: CHILDREN }, () => spawnChild(dbPath));
    await Promise.all(kids.map((c) => c.ready));
    for (const c of kids) c.proc.stdin!.write('go\n');
    const results = await Promise.all(kids.map((c) => c.done));

    for (const r of results) expect(r, r.stderr).toMatchObject({ code: 0 });

    // A subsequent (third) open succeeds normally and is a no-op.
    const h = openDb(dbPath);
    await runMigrations(h.k);
    const names = (h.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of ['_migration_lock', '_migration_state', 'memories', 'index_state', 'memory_fts', 'memory_ai', 'memory_ad', 'memory_au', 'memory_vec', 'doc_vec', 'approvals', 'audit_log', 'jobs']) {
      expect(names).toContain(t);
    }
    const state = h.raw.prepare('SELECT name FROM _migration_state ORDER BY rowid').all() as Array<{ name: string }>;
    // Each migration recorded exactly once, in order (name is the primary key, so a
    // double-run would have thrown in a child rather than duplicated here).
    expect(state.map((r) => r.name)).toEqual(['001_init', '002_fts', '003_approvals', '004_jobs']);
    await h.k.destroy();
    h.raw.close();
  }, 60_000);

  it('opens a DB migrated before _migration_lock existed without re-running migrations', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'mem-existing-')), 'fortytwo.db');
    let h = openDb(dbPath);
    await runMigrations(h.k);
    h.raw.prepare("INSERT INTO memories (content) VALUES ('kept')").run();
    h.raw.exec('DROP TABLE _migration_lock'); // shape of a DB created by memory <= 0.1.7
    const before = h.raw.prepare('SELECT name, applied_at FROM _migration_state ORDER BY rowid').all();
    await h.k.destroy();
    h.raw.close();

    h = openDb(dbPath);
    await runMigrations(h.k);
    expect(h.raw.prepare('SELECT name, applied_at FROM _migration_state ORDER BY rowid').all()).toEqual(before);
    expect(h.raw.prepare('SELECT content FROM memories').all()).toEqual([{ content: 'kept' }]);
    expect(h.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = '_migration_lock'").get()).toEqual({ n: 1 });
    await h.k.destroy();
    h.raw.close();
  });
});
