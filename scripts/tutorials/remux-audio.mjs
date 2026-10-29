// Rebuild a guide's AUDIO track from the cached narration and swap it into the
// existing mp4, without re-recording the video (2026-10-25).
//
// Why this exists: the first cut of the guides shipped with destroyed audio —
// the analyzer writes WAVE_FORMAT_EXTENSIBLE float WAVs, and lib/assemble.mjs's
// readWav read those float bytes as int32 PCM (full-scale noise). readWav is
// fixed now; this re-lays the narration (each line's cached clip at its cue
// start from the manifest) into a fresh track and remuxes it over the kept
// video. Run after any readWav/loudness change, or any time the audio is wrong
// but the frames are fine:
//
//   node --no-warnings scripts/tutorials/remux-audio.mjs           # every recorded guide
//   node --no-warnings scripts/tutorials/remux-audio.mjs api-keys  # one
//
// The video stream is copied, not re-encoded, so it is bit-for-bit the same.
// The .vtt and poster are untouched. Needs the narration still in the TTS
// cache (same lines + voice as when recorded); a missing clip skips the guide
// with a message, and that one must be re-recorded instead.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAudio, probeDuration } from './lib/assemble.mjs';
import { DEFAULT_CACHE_DIR, spoken } from './lib/tts.mjs';

const VOICE = 'af_heart';
const SPEED = 1;
const OUT_DIR = path.resolve('resources/guides/videos');

const only = process.argv[2] ?? null;
const { GUIDE_VIDEOS } = await import(pathToFileURL(path.resolve('shared/guides/videos.ts')).href);

const clipPath = (text) => path.join(DEFAULT_CACHE_DIR, `${createHash('sha1').update(`${VOICE}|${SPEED}|${spoken(text)}`).digest('hex').slice(0, 20)}.wav`);

let done = 0;
let skipped = 0;
for (const v of GUIDE_VIDEOS) {
  if (only && v.id !== only) continue;
  const mp4 = path.join(OUT_DIR, `${v.id}.mp4`);
  if (!v.cues.length || !fs.existsSync(mp4)) {
    console.log(`skip ${v.id}: not recorded`);
    continue;
  }
  const clips = v.lines.map((t, i) => ({ path: clipPath(t), startSec: v.cues[i]?.[0] ?? 0 }));
  const missing = clips.filter((c) => !fs.existsSync(c.path));
  if (missing.length) {
    console.log(`skip ${v.id}: ${missing.length} narration clip(s) not in the cache — re-record this one`);
    skipped++;
    continue;
  }
  const videoSec = probeDuration(mp4);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `remux-${v.id}-`));
  const wav = path.join(tmpDir, 'audio.wav');
  const tmpMp4 = path.join(tmpDir, 'out.mp4');
  try {
    buildAudio(clips, videoSec, wav);
    execFileSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', mp4,
      '-i', wav,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1',
      '-t', videoSec.toFixed(3),
      '-movflags', '+faststart',
      tmpMp4,
    ], { stdio: ['ignore', 'inherit', 'inherit'] });
    fs.copyFileSync(tmpMp4, mp4);
    const kb = Math.round(fs.statSync(mp4).size / 1024);
    console.log(`ok   ${v.id}: audio rebuilt from ${clips.length} clips, video copied (${videoSec.toFixed(1)}s, ${kb} KB)`);
    done++;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
console.log(`\nremux: ${done} rebuilt${skipped ? `, ${skipped} skipped (re-record)` : ''}`);
