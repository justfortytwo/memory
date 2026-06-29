import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

let dir: string, h: DbHandles;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), 'ft-jobs-')); h = openDb(join(dir, 'm.db')); await runMigrations(h.k); });
afterEach(async () => { await h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe('004_jobs migration', () => {
  it('creates the jobs table', async () => {
    expect(await h.k.schema.hasTable('jobs')).toBe(true);
  });
});
