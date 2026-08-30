// lib/images.ts — verplaats ingesloten (base64) afbeeldingen uit het offertedocument naar
// Vercel Blob en laat alleen de https-URL achter. Gebruikt door de MCP-server (bij opslaan) en
// door scripts/migrate-images.ts (bestaande offertes). Generiek: een recursieve walk vervangt
// elke stringwaarde die met "data:image/" begint, ongeacht in welk veld die staat.

import { put } from '@vercel/blob';
import { createHash } from 'node:crypto';

const DATA_IMG = /^data:image\/([a-zA-Z0-9.+-]+);base64,/;

export function isDataImage(v: unknown): v is string {
  return typeof v === 'string' && DATA_IMG.test(v);
}

export function blobConfigured(): boolean {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

function extFromMime(mime: string): string {
  const t = mime.toLowerCase();
  if (t === 'jpeg' || t === 'jpg') return 'jpg';
  if (t === 'svg+xml') return 'svg';
  return t.replace(/[^a-z0-9]/g, '') || 'png';
}

export interface OffloadStats {
  moved: number;
  failed: number;
  skipped: number;
}

// Upload one data:image string to Blob under a deterministic, content-addressed path.
// Same bytes → same path, so re-runs overwrite rather than duplicate.
async function uploadDataImage(archiveId: string, dataUrl: string): Promise<string> {
  const m = DATA_IMG.exec(dataUrl);
  if (!m) return dataUrl;
  const mime = m[1];
  const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const path = `quotes/${archiveId}/${hash}.${extFromMime(mime)}`;
  const { url } = await put(path, buf, {
    access: 'public',
    contentType: `image/${mime}`,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return url;
}

// A dry-run placeholder of representative length, so callers can estimate the resulting document
// size without actually uploading anything.
function placeholderUrl(archiveId: string, dataUrl: string): string {
  const m = DATA_IMG.exec(dataUrl);
  const buf = m ? Buffer.from(dataUrl.slice(m[0].length), 'base64') : Buffer.alloc(0);
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const ext = extFromMime(m ? m[1] : 'png');
  return `https://xxxxxxxxxxxxxxxx.public.blob.vercel-storage.com/quotes/${archiveId}/${hash}.${ext}`;
}

// Recursively walk `node`, replacing every data:image string with its Blob https-URL (mutates in
// place). With { apply:false } nothing is uploaded — a placeholder URL is written instead, purely
// for size estimation. Best-effort: an upload failure keeps the original data: URL and is counted.
export async function offloadImages(
  node: unknown,
  archiveId: string,
  opts: { apply: boolean } = { apply: true },
  stats: OffloadStats = { moved: 0, failed: 0, skipped: 0 },
): Promise<OffloadStats> {
  const handle = async (container: Record<string, unknown> | unknown[], key: string | number, value: unknown): Promise<void> => {
    if (isDataImage(value)) {
      if (!opts.apply) {
        (container as Record<string, unknown>)[key as string] = placeholderUrl(archiveId, value);
        stats.moved += 1;
        return;
      }
      try {
        (container as Record<string, unknown>)[key as string] = await uploadDataImage(archiveId, value);
        stats.moved += 1;
      } catch {
        stats.failed += 1;
      }
    } else if (value && typeof value === 'object') {
      await offloadImages(value, archiveId, opts, stats);
    }
  };

  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) await handle(node, i, node[i]);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const k of Object.keys(obj)) await handle(obj, k, obj[k]);
  }
  return stats;
}
