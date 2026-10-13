import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandles } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { memoryHead, memoryDelta } from '../src/delta.js';
const fixtures: Array<{ root: string; h: DbHandles }> = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memory-delta-'));
  const h = openDb(join(root, 'memory.db')); fixtures.push({root,h});
  await runMigrations(h.k); return h;
}
afterEach(async () => { for (const {root,h} of fixtures.splice(0)) { await h.k.destroy(); h.raw.close(); rmSync(root,{recursive:true,force:true}); } });
it('pages by insertion ID, including equal timestamps, backdated rows and deleted gaps', async () => {
  const h = await fixture(); const start = memoryHead(h);
  for (let i=0;i<5;i++) h.raw.prepare("INSERT INTO memories(content,ts) VALUES (?,?)").run(`fact ${i}`, '2000-01-01');
  h.raw.prepare('DELETE FROM memories WHERE id IN (2,5)').run();
  const a = memoryDelta(h, start, 2);
  expect(a.entries.map(r=>r.id)).toEqual([1,3]); expect(a.cursor.position).toBe(3);
  const b = memoryDelta(h,a.cursor,2);
  expect(b.entries.map(r=>r.id)).toEqual([4]); expect(b.cursor.position).toBe(5);
  h.raw.prepare("INSERT INTO memories(content) VALUES ('later')").run();
  expect(memoryDelta(h,b.cursor).entries.map(r=>r.id)).toEqual([6]);
});
it('preserves DB identity across reopen and rejects another DB cursor', async () => {
  const a=await fixture(), b=await fixture();
  expect(memoryHead(a).database).not.toBe(memoryHead(b).database);
  expect(()=>memoryDelta(b,memoryHead(a))).toThrow(/database/);
  const cursor=memoryHead(a); const record=fixtures[0]!;
  await a.k.destroy(); a.raw.close();
  record.h=openDb(join(record.root,'memory.db'));
  await runMigrations(record.h.k);
  expect(memoryHead(record.h)).toEqual(cursor);
});
it('rejects backwards cursors and invalid limits',async()=>{
  const h=await fixture(), c=memoryHead(h);
  expect(()=>memoryDelta(h,{...c,position:1})).toThrow();
  expect(()=>memoryDelta(h,c,0)).toThrow();
});
