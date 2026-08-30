// scripts/migrate-images.ts — verplaats ingesloten base64-afbeeldingen in bestaande offertes naar
// Vercel Blob en laat alleen de https-URL achter. Draait lokaal tegen dezelfde Upstash-opslag.
//
// Gebruik:
//   node scripts/migrate-images.ts <ws>            # DRY RUN — rapporteert, schrijft niets
//   node scripts/migrate-images.ts <ws> --apply    # voert de migratie echt door
//
// Vereist in de omgeving (bijv. via `vercel env pull .env` of handmatig exporteren):
//   KV_REST_API_URL / UPSTASH_REDIS_REST_URL, KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN
//   BLOB_READ_WRITE_TOKEN

import { offloadImages, blobConfigured } from '../lib/images.ts';

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24 * 365 * 2;

interface ArchiveEntry { id: string; ref?: string; data?: unknown; [k: string]: unknown }

async function redis(cmd: (string | number)[]): Promise<unknown> {
  if (!BASE || !TOKEN) throw new Error('Upstash env ontbreekt (KV_REST_API_URL / KV_REST_API_TOKEN).');
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = (await r.json()) as { error?: string; result?: unknown };
  if (j.error) throw new Error(j.error);
  return j.result;
}

const kb = (bytes: number): string => (bytes / 1024).toFixed(0) + ' kB';
const byteLen = (v: unknown): number => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ws = (args.find((a) => !a.startsWith('--')) || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);
  if (ws.length < 8) {
    console.error('Gebruik: node scripts/migrate-images.ts <ws> [--apply]');
    process.exit(1);
  }
  if (apply && !blobConfigured()) {
    console.error('FOUT: BLOB_READ_WRITE_TOKEN ontbreekt. Zet de Vercel Blob-token in de omgeving.');
    process.exit(1);
  }

  console.log(`\n${apply ? 'MIGRATIE (schrijft weg)' : 'DRY RUN (schrijft niets)'} — workspace ${ws}\n`);

  const raw = await redis(['GET', 'arch:' + ws]);
  let archive: ArchiveEntry[];
  try { archive = JSON.parse((raw as string) || '[]'); } catch { archive = []; }
  if (!Array.isArray(archive) || !archive.length) { console.log('(geen offertes gevonden)'); return; }

  let totalBefore = 0; let totalAfter = 0; let totalMoved = 0; let totalFailed = 0; let touched = 0;

  for (const entry of archive) {
    if (!entry || !entry.data) continue;
    const before = byteLen(entry.data);
    // Op de dry-run werken we op een kloon met placeholder-URLs; bij --apply muteren we in-place.
    const target = apply ? entry.data : JSON.parse(JSON.stringify(entry.data));
    const stats = await offloadImages(target, entry.id, { apply });
    if (stats.moved === 0 && stats.failed === 0) continue;
    const after = byteLen(target);
    touched += 1; totalBefore += before; totalAfter += after; totalMoved += stats.moved; totalFailed += stats.failed;
    console.log(
      `  ${(entry.ref || entry.id).padEnd(16)} ${String(stats.moved).padStart(2)} afbeelding(en)` +
      `  ${kb(before).padStart(8)} → ${kb(after).padStart(8)}` +
      (stats.failed ? `  (${stats.failed} mislukt)` : ''),
    );
  }

  console.log(`\n${touched} offerte(s) met afbeeldingen · ${totalMoved} verplaatst` +
    (totalFailed ? ` · ${totalFailed} mislukt` : '') +
    `  ·  totaal ${kb(totalBefore)} → ${kb(totalAfter)}`);

  if (apply) {
    if (totalFailed) { console.error('\nEr zijn uploads mislukt — archief NIET weggeschreven om verlies te voorkomen.'); process.exit(1); }
    await redis(['SET', 'arch:' + ws, JSON.stringify(archive), 'EX', TTL]);
    console.log('\nArchief bijgewerkt en weggeschreven. Herlaad de Offerte Tool.');
  } else {
    console.log('\nDit was een dry run. Draai opnieuw met --apply om door te voeren.');
  }
}

main().catch((e) => { console.error('FOUT:', (e as Error).message || e); process.exit(1); });
