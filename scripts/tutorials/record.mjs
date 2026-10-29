// Records the tutorial videos (2026-10-25). See ./README.md.
//
//   node scripts/tutorials/record.mjs <id | all> [--port 9333] [--voice af_heart] [--speed 1]
//        [--out resources/guides/videos] [--work <dir>] [--narrate-only] [--keep-frames]
//
// For each video in shared/guides/videos.ts that has a storyboard here:
//   1. every narration line is spoken through Krypt Voice (lib/tts.mjs) and
//      cached, so its length is known before the recording starts;
//   2. the running app (KRYPT_DEBUG_PORT, a clean --profile) is put at
//      1920×1080 and the storyboard's steps are played: each step starts its
//      line and its actions together and ends when both are done;
//   3. the screencast frames and the narration are encoded to <id>.mp4, the
//      cues to <id>.vtt, a poster to <id>.jpg, and the manifest's durationSec
//      and cues are written (lib/assemble.mjs).
//
// Nothing here touches the user's own profile: the app it drives is whatever
// answers on the debug port, and that must be a tutorial profile.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect } from './lib/cdp.mjs';
import { driver } from './lib/ui.mjs';
import { Narrator } from './lib/tts.mjs';
import { buildAudio, encode, poster, probeDuration, writeVtt } from './lib/assemble.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const manifestPath = path.join(repo, 'shared', 'guides', 'videos.ts');
const { GUIDE_VIDEOS } = await import(pathToFileURL(manifestPath).href);

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);
const want = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true) ?? 'all';
const port = Number(flag('port', process.env.KRYPT_DEBUG_PORT ?? '9333'));
const voice = flag('voice', 'af_heart');
const speed = Number(flag('speed', '1'));
const outDir = path.resolve(repo, flag('out', 'resources/guides/videos'));
const workRoot = path.resolve(flag('work', path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'krypto-mirror-tutorials', 'work')));
const narrateOnly = has('narrate-only');
const keepFrames = has('keep-frames');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${stamp()}  ${m}`);
const round2 = (n) => Math.round(n * 100) / 100;

const storyboardIds = fs
  .readdirSync(path.join(here, 'storyboards'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => f.slice(0, -4));
const ids = want === 'all' ? GUIDE_VIDEOS.map((v) => v.id).filter((id) => storyboardIds.includes(id)) : [want];
for (const id of ids) {
  if (!GUIDE_VIDEOS.some((v) => v.id === id)) throw new Error(`${id}: not in shared/guides/videos.ts`);
  if (!storyboardIds.includes(id)) throw new Error(`${id}: no storyboard in scripts/tutorials/storyboards/`);
}
fs.mkdirSync(outDir, { recursive: true });

/** Write durationSec + cues for one video into the manifest (cues on one line, as [start, end] pairs). */
function updateManifest(id, durationSec, cues) {
  let src = fs.readFileSync(manifestPath, 'utf8');
  const re = new RegExp(`(id: '${id}',[\\s\\S]*?durationSec: )(null|\\d+)(,\\r?\\n\\s*cues: )(\\[[^\\n]*\\])(,)`);
  if (!re.test(src)) throw new Error(`${id}: could not find durationSec/cues in ${manifestPath}`);
  const cueText = `[${cues.map(([s, e]) => `[${s}, ${e}]`).join(', ')}]`;
  src = src.replace(re, `$1${durationSec}$3${cueText}$5`);
  fs.writeFileSync(manifestPath, src, 'utf8');
}

async function narrate(video) {
  const narr = new Narrator({ voice, speed, log });
  const clips = [];
  for (const [i, line] of video.lines.entries()) {
    const c = await narr.speak(line);
    clips.push(c);
    log(`${video.id} line ${i + 1}/${video.lines.length}: ${c.durationSec.toFixed(1)} s${c.cached ? ' (cached)' : ''}`);
  }
  await narr.close();
  return clips;
}

async function recordOne(video) {
  const sb = (await import(pathToFileURL(path.join(here, 'storyboards', `${video.id}.mjs`)).href)).default;
  const clips = await narrate(video);
  const spoken = clips.reduce((a, c) => a + c.durationSec, 0);
  log(`${video.id}: ${video.lines.length} lines, ${spoken.toFixed(0)} s of speech`);
  if (narrateOnly) return;
  for (const step of sb.steps) {
    if (step.line != null && !(step.line in video.lines)) throw new Error(`${video.id}: a step names line ${step.line}, but there are ${video.lines.length}`);
  }

  const work = path.join(workRoot, video.id);
  const framesDir = path.join(work, 'frames');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const cdp = await connect(port);
  const ui = driver(cdp, { log });
  let frames = [];
  let t0 = null;
  let lastKept = -1;
  let dropped = 0;
  const MIN_GAP = 1 / 30 - 0.002;
  const onFrame = (p) => {
    cdp.call('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    const t = p.metadata.timestamp;
    if (t0 === null) t0 = t;
    const rel = t - t0;
    if (rel - lastKept < MIN_GAP) {
      dropped++;
      return;
    }
    lastKept = rel;
    const file = path.join(framesDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(p.data, 'base64'));
    frames.push({ file, t: rel });
  };
  const clock = () => Date.now() / 1000 - t0;

  let totalSec = 0;
  const cues = [];
  const audioClips = [];
  try {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await ui.install();
    await ui.moveTo(980, 620, 1);
    if (sb.prepare) {
      log(`${video.id}: prepare`);
      await sb.prepare(ui);
      await ui.install();
    }
    await ui.pause(600);

    const off = cdp.on('Page.screencastFrame', onFrame);
    await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    // A nudge so the compositor hands over a first frame, which fixes t0.
    await ui.moveTo(981, 621, 60);
    const t1 = Date.now();
    while (t0 === null && Date.now() - t1 < 4000) await sleep(30);
    if (t0 === null) throw new Error('no screencast frame arrived — is the window visible / not minimised?');
    log(`${video.id}: recording`);
    await ui.pause(sb.lead ?? 900);

    for (const [n, step] of sb.steps.entries()) {
      const clip = step.line != null ? clips[step.line] : null;
      const start = clock();
      if (clip) {
        cues.push({ start, end: start + clip.durationSec, text: video.lines[step.line] });
        audioClips.push({ path: clip.path, startSec: start });
        log(`${video.id} step ${n + 1}/${sb.steps.length} @${start.toFixed(1)}s: "${video.lines[step.line].slice(0, 60)}…"`);
      } else log(`${video.id} step ${n + 1}/${sb.steps.length} @${start.toFixed(1)}s (silent)`);
      const actions = step.do ? step.do(ui) : Promise.resolve();
      const speech = clip ? sleep(clip.durationSec * 1000) : Promise.resolve();
      await Promise.all([actions, speech]);
      await ui.pause(step.gap ?? sb.gap ?? 700);
    }
    await ui.pause(sb.tail ?? 1500);
    totalSec = clock();
    await cdp.call('Page.stopScreencast');
    off();
    log(`${video.id}: ${totalSec.toFixed(1)} s, ${frames.length} frames kept (${dropped} dropped)`);
  } finally {
    await cdp.call('Page.stopScreencast').catch(() => {});
    // Cleanup drives the page, so it runs while the driver is still installed.
    if (sb.cleanup) await sb.cleanup(ui).catch((e) => log(`cleanup: ${e.message}`));
    await ui.uninstall();
    await cdp.call('Emulation.clearDeviceMetricsOverride').catch(() => {});
    cdp.close();
  }

  const mp4 = path.join(outDir, `${video.id}.mp4`);
  const vtt = path.join(outDir, `${video.id}.vtt`);
  const jpg = path.join(outDir, `${video.id}.jpg`);
  const wav = path.join(work, 'narration.wav');
  buildAudio(audioClips, totalSec, wav);
  encode({ frames, audio: wav, totalSec, out: mp4, log });
  writeVtt(vtt, cues);
  const at = sb.posterAt ?? Math.min(2.5, totalSec / 2);
  poster(mp4, at, jpg);
  const dur = probeDuration(mp4);
  updateManifest(
    video.id,
    Math.round(dur),
    cues.map((c) => [round2(c.start), round2(c.end)]),
  );
  if (!keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });
  log(`${video.id}: wrote ${mp4} (${dur.toFixed(1)} s, ${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB), ${path.basename(vtt)}, ${path.basename(jpg)}; manifest updated`);
}

for (const id of ids) {
  const video = GUIDE_VIDEOS.find((v) => v.id === id);
  await recordOne(video);
}
