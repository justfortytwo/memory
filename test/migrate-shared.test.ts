import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations, applyMigrations, type Migration } from '../src/migrate.js';

let dir: string;
let h: DbHandles;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jf-mig-'));
  h = openDb(join(dir, 't.db'));
  await runMigrations(h.k);
});
afterEach(() => { h.k.destroy(); rmSync(dir, { recursive: true, force: true }); });

describe('applyMigrations', () => {
  it('records foreign migrations once and leaves memory rows untouched', async () => {
    const before = (await h.k.raw('SELECT name FROM _migration_state')) as Array<{ name: string }>;
    let runs = 0;
    const foreign: Migration[] = ['x_001', 'x_002'].map((name) => ({
      name,
      up: async (k) => { runs++; await k.raw(`CREATE TABLE ${name}_t (id integer)`); },
      down: async (k) => { await k.raw(`DROP TABLE ${name}_t`); },
    }));
    await applyMigrations(h.k, foreign);
    await applyMigrations(h.k, foreign);
    expect(runs).toBe(2);
    const after = (await h.k.raw('SELECT name FROM _migration_state ORDER BY name')) as Array<{ name: string }>;
    const names = after.map((r) => r.name);
    expect(names.filter((n) => n.startsWith('x_'))).toEqual(['x_001', 'x_002']);
    expect(names.filter((n) => !n.startsWith('x_')).sort()).toEqual(before.map((r) => r.name).sort());
  });
});
