// Narration through Krypt Studio's local voice engine (2026-10-25).
//
// Krypt Voice's local engine is Kokoro-82M (Apache-2.0) run by Krypt
// Studio's analyzer sidecar, `krypt-studio-analyzer.exe`: one JSON line per
// request on stdin, one per response on stdout (its docs/ANALYZER_PROTOCOL.md,
// "Text to speech"). We drive the exe directly, so Studio itself need not be
// running. The model folder holds model.onnx and <voice>.bin files, flat —
// the same files Studio's Model Manager installs (pinned revision + sha256 in
// its shared/analyzer/models.ts).
//
// Output: mono float32 WAV at 24 kHz, plus per-word timings. Deterministic
// for the same text, voice and speed, so lines are cached by their hash.
//
//   KRYPT_ANALYZER_EXE  path to krypt-studio-analyzer.exe
//   KRYPT_KOKORO_DIR    folder with model.onnx + <voice>.bin
//   (defaults below fit this machine; override for another)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_EXE = process.env.KRYPT_ANALYZER_EXE ?? 'C:\\Users\\Krypt\\AppData\\Local\\Programs\\Krypt Studio\\resources\\resources\\bin\\krypt-studio-analyzer.exe';
export const DEFAULT_MODEL_DIR = process.env.KRYPT_KOKORO_DIR ?? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'krypto-mirror-tutorials', 'models', 'kokoro');
export const DEFAULT_CACHE_DIR = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'krypto-mirror-tutorials', 'tts-cache');

/**
 * How the written line is SPOKEN. The transcript keeps "pump.fun"; the voice
 * must not read a sentence break at that dot, and spelled-out acronyms read
 * better as words where people say them as words.
 */
const SPOKEN = [
  [/pump\.fun/g, 'pump fun'],
  [/helius\.dev/g, 'helius dot dev'],
  [/lite-api\.jup\.ag/g, 'lite A P I dot jup dot A G'],
  [/api\.jup\.ag/g, 'A P I dot jup dot A G'],
  [/portal\.jup\.ag/g, 'portal dot jup dot A G'],
  [/bds\.birdeye\.so/g, 'B D S dot birdeye dot S O'],
  [/krypt\.cc/g, 'krypt dot C C'],
  [/\bSOL\b/g, 'sol'],
  [/\bGIPHY\b/g, 'giphy'],
  [/\bKrypt\b/g, 'kript'],
  [/\bKrypto\b/g, 'kripto'],
  [/\bFOMO\b/g, 'fomo'],
  [/\bEVM\b/g, 'E V M'],
  [/\bRPC\b/g, 'R P C'],
  [/\bUSDC\b/g, 'U S D C'],
  [/\bmcap\b/gi, 'market cap'],
  [/—/g, ','],
  [/–/g, ','],
];

export function spoken(text) {
  let t = text;
  for (const [re, to] of SPOKEN) t = t.replace(re, to);
  return t;
}

export class Narrator {
  constructor(opts = {}) {
    this.exe = opts.exe ?? DEFAULT_EXE;
    this.modelDir = opts.modelDir ?? DEFAULT_MODEL_DIR;
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
    this.voice = opts.voice ?? 'af_heart';
    this.speed = opts.speed ?? 1;
    this.log = opts.log ?? (() => {});
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = '';
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  check() {
    if (!fs.existsSync(this.exe)) throw new Error(`analyzer not found: ${this.exe} (set KRYPT_ANALYZER_EXE)`);
    const model = path.join(this.modelDir, 'model.onnx');
    const voice = path.join(this.modelDir, `${this.voice}.bin`);
    if (!fs.existsSync(model)) throw new Error(`Kokoro model not found: ${model} (set KRYPT_KOKORO_DIR; see scripts/tutorials/README.md)`);
    if (!fs.existsSync(voice)) throw new Error(`voice file not found: ${voice}`);
  }

  start() {
    if (this.proc) return;
    this.check();
    const p = spawn(this.exe, [], { cwd: path.dirname(this.exe), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => {
      this.buf += d;
      const lines = this.buf.split('\n');
      this.buf = lines.pop();
      for (const line of lines) {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        // Events (progress, log) carry the job's id too: only a response settles it.
        if (m.event) {
          if (m.event === 'log' && m.level !== 'info') this.log(`analyzer ${m.level}: ${m.message}`);
          continue;
        }
        if (m.id && this.pending.has(m.id)) {
          this.pending.get(m.id)(m);
          this.pending.delete(m.id);
        }
      }
    });
    p.stderr.on('data', (d) => this.log(`analyzer: ${String(d).trim().slice(0, 300)}`));
    p.on('exit', (code) => {
      this.proc = null;
      for (const [, res] of this.pending) res({ ok: false, message: `analyzer exited (${code})` });
      this.pending.clear();
    });
    this.proc = p;
  }

  request(cmd, args) {
    this.start();
    return new Promise((res) => {
      const id = this.nextId++;
      this.pending.set(id, res);
      this.proc.stdin.write(JSON.stringify(args ? { id, cmd, args } : { id, cmd }) + '\n');
    });
  }

  /**
   * Speak one line. Returns { path, durationSec, words, text, spokenText }.
   * Cached by sha1(voice, speed, spoken text).
   */
  async speak(text) {
    const say = spoken(text);
    const key = createHash('sha1').update(`${this.voice}|${this.speed}|${say}`).digest('hex').slice(0, 20);
    const wav = path.join(this.cacheDir, `${key}.wav`);
    const meta = path.join(this.cacheDir, `${key}.json`);
    if (fs.existsSync(wav) && fs.existsSync(meta)) {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      return { ...m, path: wav, text, spokenText: say, cached: true };
    }
    const r = await this.request('tts', { text: say, voice: this.voice, speed: this.speed, out: wav, modelDir: this.modelDir });
    if (!r.ok) throw new Error(`tts failed for "${text.slice(0, 60)}": ${r.message}`);
    const m = { durationSec: r.data.durationSec, words: r.data.words ?? [], sampleRate: r.data.sampleRate };
    fs.writeFileSync(meta, JSON.stringify(m));
    return { ...m, path: wav, text, spokenText: say, cached: false };
  }

  async close() {
    if (!this.proc) return;
    await this.request('shutdown');
    this.proc = null;
  }
}
