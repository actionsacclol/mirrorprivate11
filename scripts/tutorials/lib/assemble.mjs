// Assembly (2026-10-25): screencast frames + narration clips → one mp4, a
// WebVTT caption file and a poster jpg, all through ffmpeg (on PATH).
//
// Frames arrive from Page.startScreencast with wall-clock timestamps and
// only when something changed, so the video is built with the concat
// demuxer (each frame held until the next) and converted to constant
// 30 fps. The audio track is built here, sample by sample: silence with
// each narration clip (mono float32, 24 kHz) placed at the second it was
// started during the recording.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Parse a RIFF WAV into { rate, channels, samples: Float32Array } (float32 or PCM16, mono or first channel). */
export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`not a WAV: ${file}`);
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4);
    const len = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = b.readUInt16LE(body);
      const bits = b.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE (0xFFFE): the real format tag is the first two
      // bytes of the SubFormat GUID, 24 bytes into the chunk (after the
      // 22-byte extension). The analyzer writes 32-bit float this way; reading
      // those bytes as int32 PCM is full-scale noise, not audio.
      if (format === 0xfffe && body + 26 <= b.length) format = b.readUInt16LE(body + 24);
      fmt = { format, channels: b.readUInt16LE(body + 2), rate: b.readUInt32LE(body + 4), bits };
    }
    if (id === 'data') data = { start: body, end: Math.min(b.length, body + len) };
    pos = body + len + (len % 2);
  }
  if (!fmt || !data) throw new Error(`WAV without fmt/data: ${file}`);
  const bytesPer = fmt.bits / 8;
  const frames = Math.floor((data.end - data.start) / (bytesPer * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const at = data.start + i * bytesPer * fmt.channels;
    out[i] = fmt.format === 3 ? b.readFloatLE(at) : fmt.bits === 16 ? b.readInt16LE(at) / 32768 : b.readInt32LE(at) / 2147483648;
  }
  return { rate: fmt.rate, channels: fmt.channels, samples: out };
}

/** Write mono 16-bit PCM. */
export function writeWav16(file, samples, rate) {
  const n = samples.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, b);
}

/**
 * Lay narration clips on a silent track.
 * @param {{ path: string; startSec: number }[]} clips
 * @param {number} totalSec
 */
export function buildAudio(clips, totalSec, outFile, rate = 24000) {
  const total = Math.ceil(totalSec * rate);
  const mix = new Float32Array(total);
  for (const c of clips) {
    const w = readWav(c.path);
    if (w.rate !== rate) throw new Error(`clip rate ${w.rate} ≠ ${rate}: ${c.path}`);
    const at = Math.round(c.startSec * rate);
    for (let i = 0; i < w.samples.length && at + i < total; i++) mix[at + i] += w.samples[i];
  }
  writeWav16(outFile, mix, rate);
}

const pad2 = (n) => String(n).padStart(2, '0');
export function vttTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(ms % 1000).padStart(3, '0')}`;
}

/** WebVTT from cues [{ start, end, text }]. */
export function writeVtt(file, cues) {
  const lines = ['WEBVTT', ''];
  cues.forEach((c, i) => {
    lines.push(String(i + 1), `${vttTime(c.start)} --> ${vttTime(c.end)}`, c.text, '');
  });
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
}

/**
 * Encode the frames + audio to H.264/AAC.
 * @param {{ file: string; t: number }[]} frames  t = seconds from the recording's start, ascending
 */
export function encode({ frames, audio, totalSec, out, fps = 30, crf = 23, preset = 'medium', log = () => {} }) {
  if (!frames.length) throw new Error('no frames');
  const listFile = path.join(path.dirname(frames[0].file), 'frames.txt');
  const lines = [];
  const fwd = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  // The first frame stands in from 0; each frame holds until the next.
  for (let i = 0; i < frames.length; i++) {
    const start = i === 0 ? 0 : frames[i].t;
    const end = i + 1 < frames.length ? frames[i + 1].t : totalSec;
    const d = Math.max(0.001, end - start);
    lines.push(`file '${fwd(frames[i].file)}'`, `duration ${d.toFixed(4)}`);
  }
  // concat demuxer quirk: the last duration is only honoured if the file is named once more.
  lines.push(`file '${fwd(frames[frames.length - 1].file)}'`);
  fs.writeFileSync(listFile, lines.join('\n') + '\n', 'utf8');
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', `fps=${fps},scale=1920:1080:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-tune', 'stillimage', '-profile:v', 'high', '-level', '4.1',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '1',
    '-t', totalSec.toFixed(3),
    '-movflags', '+faststart',
    out,
  ];
  log(`ffmpeg ${args.join(' ').slice(0, 200)}…`);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
}

/** A poster frame from the finished mp4 (1280 wide jpg). */
export function poster(mp4, at, out) {
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(2), '-i', mp4, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', out], { stdio: 'inherit' });
}

/** Seconds, from ffprobe. */
export function probeDuration(file) {
  const s = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim();
  return Number(s);
}
