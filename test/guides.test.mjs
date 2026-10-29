// Guides (2026-10-25): the tutorial videos. The manifest (shared/guides/videos.ts)
// and the shipped files (resources/guides/videos) must agree — a recorded
// video has its three files, its length and one cue per narration line, and
// an unrecorded one has no files pretending otherwise. The main-process
// protocol that streams them answers ranges (so <video> can seek) and never
// leaves its folder. The storyboards speak every line, once, in order. And
// the app reaches the guides from the bar, Settings, Home and onboarding.
//
// Bundles: test/.guides.mjs (shared manifest), test/.guidevideos.mjs
// (electron/system/guideVideos.ts over the electron stub) — scripts/test-steps.json.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GUIDE_VIDEOS, GUIDE_VIDEO_FILE, GUIDE_VIDEO_ORIGIN, QUICKSTART_VIDEO, VIDEO_CREDIT, cueAt, fmtVideoDuration, isReady, videoUrls } from './.guides.mjs';
import { GUIDE_SCHEME_PRIVILEGES, guideVideoResponse, parseRange } from './.guidevideos.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const videosDir = path.join(root, 'resources', 'guides', 'videos');

/** Seconds from an mp4's moov/mvhd box. */
function mp4Duration(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const readAt = (pos, len) => {
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, pos);
      return b;
    };
    const find = (type, start, end) => {
      let pos = start;
      while (pos + 8 <= end) {
        const h = readAt(pos, 16);
        let len = h.readUInt32BE(0);
        const t = h.toString('latin1', 4, 8);
        let header = 8;
        if (len === 1) {
          len = Number(h.readBigUInt64BE(8));
          header = 16;
        } else if (len === 0) len = end - pos;
        if (len < header) return null;
        if (t === type) return { body: pos + header, end: pos + len };
        pos += len;
      }
      return null;
    };
    const moov = find('moov', 0, size);
    if (!moov) return null;
    const mvhd = find('mvhd', moov.body, moov.end);
    if (!mvhd) return null;
    const b = readAt(mvhd.body, 32);
    const v = b.readUInt8(0);
    const timescale = v === 1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
    const duration = v === 1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
    return timescale ? duration / timescale : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** [{ start, end, text }] from a WebVTT file. */
function vttCues(text) {
  const out = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i === -1) continue;
    const [a, c] = lines[i].split('-->').map((s) => s.trim());
    const sec = (t) => {
      const [h, m, s] = t.split(':');
      return Number(h) * 3600 + Number(m) * 60 + Number(s);
    };
    out.push({ start: sec(a), end: sec(c), text: lines.slice(i + 1).join('\n').replace(/\n+$/, '') });
  }
  return out;
}

{
  const ids = GUIDE_VIDEOS.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const v of GUIDE_VIDEOS) {
    assert.ok(GUIDE_VIDEO_FILE.test(`${v.id}.mp4`), `${v.id}: an id the protocol will serve`);
    assert.ok(v.title.length > 4 && v.description.length > 10, `${v.id}: titled and described`);
    assert.ok(v.lines.length >= 5, `${v.id}: has a narration`);
    for (const [i, l] of v.lines.entries()) {
      assert.ok(l.length >= 12 && l.length <= 300, `${v.id} line ${i + 1}: a spoken sentence or two (${l.length} chars)`);
      assert.ok(!/[\n\]]/.test(l), `${v.id} line ${i + 1}: no newline or ']' (the recorder writes cues on one line)`);
    }
    assert.ok(Array.isArray(v.cues), `${v.id}: cues is an array`);
  }
  assert.ok(ids.includes(QUICKSTART_VIDEO), 'the quickstart is a guide');
  assert.deepEqual(videoUrls('x'), { video: `${GUIDE_VIDEO_ORIGIN}/x.mp4`, poster: `${GUIDE_VIDEO_ORIGIN}/x.jpg`, captions: `${GUIDE_VIDEO_ORIGIN}/x.vtt` });
  assert.equal(GUIDE_VIDEO_ORIGIN, 'krypt-guide://v');
  assert.equal(fmtVideoDuration(183), '3:03');
  assert.equal(fmtVideoDuration(null), '');
  const sample = { cues: [[0.5, 4], [5, 9.5]] };
  assert.equal(cueAt(sample, 0.2), -1);
  assert.equal(cueAt(sample, 2), 0);
  assert.equal(cueAt(sample, 4.2), 0, 'a line lingers a third of a second after it ends');
  assert.equal(cueAt(sample, 6), 1);
  assert.equal(cueAt(sample, 12), -1);
  assert.match(VIDEO_CREDIT, /Kokoro-82M/, 'the voice is credited');
  ok(`manifest: ${GUIDE_VIDEOS.length} guides, ids, lines, urls, cue lookup`);
}

{
  let recorded = 0;
  for (const v of GUIDE_VIDEOS) {
    const file = (ext) => path.join(videosDir, `${v.id}.${ext}`);
    const has = (ext) => fs.existsSync(file(ext));
    if (!isReady(v)) {
      assert.ok(!has('mp4'), `${v.id}: an mp4 is on disk but the manifest says not recorded — run scripts/tutorials/record.mjs ${v.id}`);
      assert.equal(v.cues.length, 0, `${v.id}: no cues before it is recorded`);
      continue;
    }
    recorded++;
    for (const ext of ['mp4', 'vtt', 'jpg']) assert.ok(has(ext), `${v.id}: ${v.id}.${ext} ships`);
    const secs = mp4Duration(file('mp4'));
    assert.ok(secs !== null && Math.abs(secs - v.durationSec) <= 1.5, `${v.id}: the manifest length (${v.durationSec}) matches the mp4 (${secs?.toFixed(1)})`);
    assert.equal(v.cues.length, v.lines.length, `${v.id}: one cue per line`);
    let prevEnd = -1;
    for (const [i, [s, e]] of v.cues.entries()) {
      assert.ok(s >= 0 && e > s, `${v.id} cue ${i + 1}: starts before it ends`);
      assert.ok(s >= prevEnd - 0.01, `${v.id} cue ${i + 1}: after the one before`);
      assert.ok(e <= v.durationSec + 1, `${v.id} cue ${i + 1}: inside the video`);
      prevEnd = e;
    }
    const cues = vttCues(fs.readFileSync(file('vtt'), 'utf8'));
    assert.equal(cues.length, v.lines.length, `${v.id}: the captions file has one cue per line`);
    cues.forEach((c, i) => {
      assert.equal(c.text, v.lines[i], `${v.id} caption ${i + 1} is the line`);
      assert.ok(Math.abs(c.start - v.cues[i][0]) < 0.02 && Math.abs(c.end - v.cues[i][1]) < 0.02, `${v.id} caption ${i + 1} is timed like the manifest`);
    });
    const mb = fs.statSync(file('mp4')).size / 1e6;
    assert.ok(mb < 40, `${v.id}: ${mb.toFixed(1)} MB is a tutorial, not a feature film`);
  }
  // Nothing on disk that the manifest does not know about.
  if (fs.existsSync(videosDir)) {
    for (const f of fs.readdirSync(videosDir)) {
      const m = GUIDE_VIDEO_FILE.exec(f);
      if (!m) continue;
      assert.ok(GUIDE_VIDEOS.some((v) => v.id === m[1]), `${f}: in the folder but not in the manifest`);
    }
  }
  ok(`files and manifest agree (${recorded} of ${GUIDE_VIDEOS.length} recorded)`);
}

{
  assert.equal(parseRange(null, 100), null);
  assert.equal(parseRange('bytes=-', 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'an end past the file is clipped');
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 }, 'a suffix range');
  assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=50-40', 100), 'unsatisfiable');
  assert.equal(parseRange('bytes=0-1,5-6', 100), null, 'multi-range falls back to the whole file');
  assert.equal(GUIDE_SCHEME_PRIVILEGES.scheme, 'krypt-guide');
  assert.deepEqual(GUIDE_SCHEME_PRIVILEGES.privileges, { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false });
  ok('ranges: single ranges, suffixes, clipping, 416s; the scheme is standard, secure, streaming');
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krypt-guides-'));
  const body = Buffer.alloc(1000);
  for (let i = 0; i < body.length; i++) body[i] = i % 251;
  fs.writeFileSync(path.join(dir, 'demo.mp4'), body);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'inner.mp4'), body);
  const bytes = async (r) => Buffer.from(await r.arrayBuffer());

  let r = await guideVideoResponse('demo.mp4', dir);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'video/mp4');
  assert.equal(r.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(r.headers.get('Content-Length'), '1000');
  assert.ok((await bytes(r)).equals(body), 'the whole file');

  r = await guideVideoResponse('demo.mp4', dir, 'GET', 'bytes=100-199');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 100-199/1000');
  assert.equal(r.headers.get('Content-Length'), '100');
  assert.ok((await bytes(r)).equals(body.subarray(100, 200)), 'exactly the range');

  r = await guideVideoResponse('demo.mp4', dir, 'GET', 'bytes=2000-');
  assert.equal(r.status, 416);
  assert.equal(r.headers.get('Content-Range'), 'bytes */1000');

  r = await guideVideoResponse('demo.mp4', dir, 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Length'), '1000');
  assert.equal((await bytes(r)).length, 0, 'HEAD has no body');

  assert.equal((await guideVideoResponse('demo.mp4', dir, 'POST')).status, 405);
  assert.equal((await guideVideoResponse('notes.txt', dir)).status, 404, 'only the three types');
  assert.equal((await guideVideoResponse('sub/inner.mp4', dir)).status, 404, 'no folders');
  assert.equal((await guideVideoResponse('../demo.mp4', dir)).status, 404, 'never outside');
  assert.equal((await guideVideoResponse('Demo.mp4', dir)).status, 404, 'lower-case ids only');
  assert.equal((await guideVideoResponse('missing.mp4', dir)).status, 404);
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the protocol serves whole files and ranges, and nothing else');
}

{
  const sbDir = path.join(root, 'scripts', 'tutorials', 'storyboards');
  const files = fs.readdirSync(sbDir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'));
  assert.ok(files.length >= 5, 'five storyboards at least');
  for (const f of files) {
    const id = f.slice(0, -4);
    const v = GUIDE_VIDEOS.find((x) => x.id === id);
    assert.ok(v, `${f}: a storyboard for a guide in the manifest`);
    const sb = (await import(pathToFileURL(path.join(sbDir, f)).href)).default;
    assert.ok(Array.isArray(sb.steps) && sb.steps.length > 0, `${id}: has steps`);
    const spoken = sb.steps.map((s) => s.line).filter((l) => l != null);
    assert.deepEqual(spoken, v.lines.map((_, i) => i), `${id}: speaks every line once, in order`);
    for (const s of sb.steps) assert.ok(typeof s.do === 'function' || s.line != null, `${id}: a step does something or says something`);
  }
  for (const v of GUIDE_VIDEOS) assert.ok(files.includes(`${v.id}.mjs`), `${v.id}: has a storyboard`);
  const rec = read('scripts/tutorials/record.mjs');
  assert.match(rec, /function updateManifest\(id, durationSec, cues\)/, 'the recorder writes the length and cues back');
  assert.match(rec, /Page\.startScreencast/, 'frames come from the screencast');
  const tts = read('scripts/tutorials/lib/tts.mjs');
  assert.match(tts, /krypt-studio-analyzer\.exe/, 'the voice is Krypt Studio’s analyzer');
  assert.match(tts, /\[\/pump\\\.fun\/g, 'pump fun'\]/, 'pump.fun is not read as a sentence break');
  const ui = read('scripts/tutorials/lib/ui.mjs');
  assert.match(ui, /Input\.dispatchMouseEvent/, 'clicks are real input events');
  assert.ok(fs.existsSync(path.join(root, 'scripts', 'tutorials', 'README.md')), 'the pipeline is documented');
  ok('storyboards: one per guide, every line spoken once in order; the recorder and voice are what the README says');
}

{
  assert.match(read('src/state/nav.tsx'), /export type SettingsTab = 'general' \| 'guides' \| 'console' \| 'about' \| 'legal';/, 'Guides is a Settings tab');
  assert.match(read('src/state/nav.tsx'), /guide: string \| null;/, 'and the bar can ask for one guide');
  assert.match(read('src/App.tsx'), /guide: opts\?\.guide \?\? null,/, 'the asked-for guide travels with go()');
  const hub = read('src/pages/SettingsHub.tsx');
  assert.match(hub, /\{ value: 'guides', label: 'Guides' \},/, 'the tab is on the hub');
  assert.match(hub, /\{tab === 'guides' && <GuidesPage \/>\}/, 'and renders the page');
  assert.match(read('src/shell/TopNav.tsx'), /data-testid="nav-guides"/, 'the bar has a door to the guides');
  const home = read('src/pages/Home.tsx');
  assert.match(home, /data-testid="home-quickstart"/, 'Home offers the quickstart');
  assert.match(home, /v\.id === QUICKSTART_VIDEO && isReady\(v\)/, 'only once it is recorded');
  const ob = read('src/components/Onboarding.tsx');
  assert.match(ob, /<InlineGuide id="api-keys"/, 'the keys step plays the keys guide in place');
  assert.match(ob, /<InlineGuide id="quickstart"/, 'the last step plays the quickstart in place');
  assert.ok(!/openExternal\((API_KEYS_VIDEO_URL|APP_WALKTHROUGH_URL)\)/.test(ob), 'no more YouTube hand-offs');
  assert.ok(!fs.existsSync(path.join(root, 'src', 'guideVideos.ts')), 'the old link list is gone');
  const player = read('src/components/GuideVideoPlayer.tsx');
  assert.match(player, /cueAt\(video, e\.currentTarget\.currentTime\)/, 'captions are drawn from the manifest’s cues');
  assert.ok(!/<track\s/.test(player), 'no <track> element (no cross-origin captions fetch)');
  assert.match(player, /if \(!video \|\| !isReady\(video\)\) return null;/, 'an unrecorded guide offers no inline player');
  const guides = read('src/pages/Guides.tsx');
  assert.match(guides, /GUIDE_VIDEOS\.map\(\(v\) => \(/, 'every guide is listed');
  assert.match(guides, /\{VIDEO_CREDIT\}/, 'with the voice credit');
  assert.match(read('src/pages/About.tsx'), /\{VIDEO_CREDIT\}/, 'About credits the voice too');
  ok('the app reaches the guides from the bar, Settings, Home and onboarding; captions are drawn, not fetched');
}

{
  const csp = read('electron/system/webSecurity.ts');
  assert.match(csp, /"img-src 'self' data: blob: krypt-img: krypt-guide:"/, 'posters pass the packaged CSP');
  assert.match(csp, /"media-src 'self' blob: krypt-guide:"/, 'videos pass the packaged CSP');
  assert.match(csp, /`img-src 'self' data: blob: krypt-img: krypt-guide: \$\{origin\}`/, 'and the dev CSP');
  assert.equal((csp.match(/"media-src 'self' blob: krypt-guide:"/g) ?? []).length, 2, 'media-src in both policies');
  const images = read('electron/data/images.ts');
  assert.match(images, /GUIDE_SCHEME_PRIVILEGES,\n  \]\);/, 'the one privileged-schemes call carries the guide scheme');
  const main = read('electron/main.ts');
  assert.match(main, /registerGuideProtocol\(\);/, 'main serves the videos');
  const gv = read('electron/system/guideVideos.ts');
  assert.match(gv, /process\.resourcesPath, 'guides', 'videos'/, 'packaged: beside the app’s resources');
  assert.match(gv, /app\.getAppPath\(\), 'resources', 'guides', 'videos'/, 'unpackaged: the repo folder');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('!resources/guides/**'), 'the videos stay out of the asar');
  assert.deepEqual(pkg.build.extraResources, [{ from: 'resources/guides/videos', to: 'guides/videos', filter: ['*.mp4', '*.vtt', '*.jpg'] }], 'and ship as extraResources');
  ok('CSP, scheme registration, protocol wiring and packaging');
}

console.log(`\nguides: ${passed}/${passed} passed`);
