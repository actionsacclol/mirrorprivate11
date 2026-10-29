// The tutorial videos (shared/guides/videos.ts), served read-only to the
// renderer under krypt-guide://v/<id>.<mp4|vtt|jpg> (2026-10-25).
//
// Why a scheme of our own: the packaged renderer is a file:// page and
// `net.fetch` on file:// does not answer Range requests, so a <video> could
// play but never seek. This handler answers ranges with 206s from a stream.
// Only flat file names matching GUIDE_VIDEO_FILE are served — no folders,
// no other types, never outside the folder — and the folder is the one the
// build ships (electron-builder extraResources → <resources>/guides/videos),
// or the repo's resources/guides/videos in an unpackaged run.
//
// The scheme is registered as privileged (standard, secure, streaming) in
// ONE call together with krypt-img: Electron allows that call once per
// process (electron/data/images.ts, registerImageScheme).

import { app, protocol } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GUIDE_VIDEO_FILE, GUIDE_VIDEO_HOST, GUIDE_VIDEO_SCHEME } from '@shared/guides/videos';

/** For protocol.registerSchemesAsPrivileged, alongside the image scheme. */
export const GUIDE_SCHEME_PRIVILEGES = {
  scheme: GUIDE_VIDEO_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false },
} as const;

/** Where the shipped files are. */
export function guideVideosDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'guides', 'videos') : path.join(app.getAppPath(), 'resources', 'guides', 'videos');
}

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  vtt: 'text/vtt; charset=utf-8',
  jpg: 'image/jpeg',
};

export type ByteRange = { start: number; end: number };

/**
 * One `bytes=` range against a file of `size` bytes. null = no usable range
 * header (serve the whole file; multi-range and malformed headers fall back
 * to that, as RFC 9110 allows); 'unsatisfiable' → 416.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // suffix: the last N bytes
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/**
 * Answer a request for `name` (the path after the host, already URL-decoded)
 * from `root`. Never throws: problems become 4xx / 5xx responses.
 */
export async function guideVideoResponse(name: string, root: string, method = 'GET', rangeHeader: string | null = null): Promise<Response> {
  try {
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'method not allowed');
    const m = GUIDE_VIDEO_FILE.exec(name);
    if (!m) return text(404, 'not found');
    const base = path.resolve(root);
    const file = path.resolve(base, name);
    if (path.dirname(file) !== base) return text(403, 'forbidden');
    let size: number;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) return text(404, 'not found');
      size = st.size;
    } catch {
      return text(404, 'not found');
    }
    const headers: Record<string, string> = {
      'Content-Type': TYPES[m[2]],
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const range = parseRange(rangeHeader, size);
    if (range === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const length = size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = String(length);
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const status = range ? 206 : 200;
    if (method === 'HEAD' || length === 0) return new Response(null, { status, headers });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status, headers });
  } catch (err) {
    return text(500, `error: ${(err as Error)?.message ?? err}`);
  }
}

/** After app-ready. */
export function registerGuideProtocol(root: string = guideVideosDir()): void {
  protocol.handle(GUIDE_VIDEO_SCHEME, async (req) => {
    try {
      const url = new URL(req.url);
      if (url.host !== GUIDE_VIDEO_HOST) return text(404, 'not found');
      const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      return await guideVideoResponse(name, root, req.method, req.headers.get('range'));
    } catch {
      return text(500, 'error');
    }
  });
}
