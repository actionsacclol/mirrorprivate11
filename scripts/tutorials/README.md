# Tutorial videos

The guides under Settings › Guides are short narrated recordings of the app
itself, made here: a storyboard drives a clean profile of the running app
over the Chrome DevTools Protocol while its frames are captured, and the
narration is spoken by Krypt Voice — Krypt Studio's local text-to-speech
engine (Kokoro-82M, Apache-2.0). Nothing is recorded by hand, so a take is
repeatable: when the UI changes, change the storyboard and record again.

What ships: `resources/guides/videos/<id>.mp4` (H.264/AAC, 1920×1080, 30 fps),
`<id>.vtt` (captions) and `<id>.jpg` (poster), as electron-builder
extraResources, served to the renderer at `krypt-guide://v/<id>.…`
(`electron/system/guideVideos.ts`). The manifest is `shared/guides/videos.ts`:
the titles, the narration lines (what the voice says, what the captions show
and what the written guide lists) and, written by the recorder, each video's
length and the second every line starts and ends.

## One-time setup

1. **Krypt Studio** installed (the analyzer sidecar does the speaking):
   `C:\Users\<you>\AppData\Local\Programs\Krypt Studio\resources\resources\bin\krypt-studio-analyzer.exe`,
   or set `KRYPT_ANALYZER_EXE`. Studio itself need not be running.
2. **The Kokoro model**, flat in one folder (`KRYPT_KOKORO_DIR`, default
   `%LOCALAPPDATA%\krypto-mirror-tutorials\models\kokoro`): `model.onnx` plus
   one `<voice>.bin` per voice you use. These are the files Studio's Model
   Manager installs, from
   `https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model.onnx`
   and `…/voices/<voice>.bin` (sha256 per file in Studio's
   `shared/analyzer/models.ts`). Default voice `af_heart`; others: `af_bella`,
   `am_michael`, `bm_george`, … (`--voice`).
3. **ffmpeg** and **ffprobe** on PATH (ffmpeg 6+; libx264 and aac).
4. **A tutorial profile** of the app, so no recording ever shows your own
   wallet, keys or follows. Add it to the profile registry
   (`%APPDATA%\Krypto Mirror Profiles\profiles.json`, or `Krypto Copy Profiles`
   on an install that kept the old folder), written WITHOUT a byte-order mark:

   ```json
   {"version":1,"profiles":[{"id":"tutorial","name":"Tutorial","createdAt":1792949013000,"colour":"sky"}]}
   ```

   The board needs data: copy `wallet-scout.json`, `wallet-scout-seen.bin`,
   `chain-births.json`, `chain-prices.json` and `creators.json` from your own
   profile folder into `…Profiles\tutorial\` (public market data only — never
   `settings.json`, `wallets.json` or `copytrade.json`).

## Recording

Build the renderer once (`npx vite build`), then start the tutorial instance
with the debug port and no dev server (PowerShell):

```powershell
scripts\tutorials\instance.ps1 start      # also: stop, restart, unfollow, firstrun
```

which runs `electron.exe . --profile=tutorial --no-sandbox
--disable-features=CalculateNativeWinOcclusion --disable-renderer-backgrounding`
with `KRYPT_DEBUG_PORT=9333` and waits for the port. (The two Chromium
switches keep frames coming when the window is covered. Leave the window
alone while a take runs: it is being driven, and a click of yours changes
the profile's state.)

Then:

```
node scripts/tutorials/record.mjs all            # every video with a storyboard
node scripts/tutorials/record.mjs api-keys       # one
node scripts/tutorials/record.mjs all --narrate-only   # just speak and cache the lines
```

Options: `--port`, `--voice af_heart`, `--speed 1`, `--out resources/guides/videos`,
`--work <dir>` (frames and the audio track; default
`%LOCALAPPDATA%\krypto-mirror-tutorials\work`), `--keep-frames`.

The app shows the result under Settings › Guides (and the book icon on the
bar): the player, captions drawn from the manifest's cues, and the lines as
a numbered, clickable transcript. The files are served to the renderer at
`krypt-guide://v/<id>.<ext>` (electron/system/guideVideos.ts, with Range
support so seeking works) from `resources/guides/videos`, which
electron-builder ships beside the asar as `extraResources`.

Each take: the lines are spoken first (cached by text + voice in
`%LOCALAPPDATA%\krypto-mirror-tutorials\tts-cache`), the page is put at
1920×1080, the storyboard's `prepare` runs, then every step starts its line
and its actions together and ends when both have. Frames are encoded, the
captions and poster written, and the manifest's `durationSec` and `cues`
updated. `npm test` (test/guides.test.mjs) checks the files and the manifest
agree.

### Resetting between takes

The takes depend on the profile's state, so record them in this order from
a set-up profile with **no follows and no key** (`instance.ps1 unfollow`:
closes the instance, deletes `…Profiles\tutorial\copytrade.json` and any
Helius key, starts it again): `api-keys`, `follow-settings` (makes the
follow the next take needs), `wallet-live` (generates the tutorial wallet),
`ai-desk` (switches the AI connection on at Paper trading, gates that follow,
then puts both back and fails its cleanup loudly if the gate stays on),
`discover-check`, then `convergence` (run `instance.ps1 unfollow` again first: it starts a crowd follow, and seeds and removes its own address-book tag). A wallet that is already followed shows "Manage follow"
instead of "Follow on paper", which is why the follows go first.

The quickstart shows the first run, so for it the profile must be at its
first run (`instance.ps1 firstrun`: with the instance closed, deletes
`legal-acceptance.jsonl`, `copytrade.json`, `wallet.json`, `wallets.json`
and `evm-wallets.json` from `…Profiles\tutorial`, sets `"onboarded": false`
in its `settings.json` without a BOM, and starts it again). Record it last,
so the "Watch…" rows its onboarding shows point at guides that exist.

Every take re-records the whole video, so after any UI change rebuild
(`npx vite build`), restart the instance and record again: the frames must
show the app as it ships.

## Writing a storyboard

`scripts/tutorials/storyboards/<id>.mjs` exports `{ prepare?, steps, cleanup?, posterAt? }`.
A step is `{ line: <index into the manifest's lines>, do: async (ui) => … }`
(or no line for a silent beat). The driver (`lib/ui.mjs`) gives `click`,
`type`, `hover`, `point` (hover + glow), `spot`, `wheel`, `waitFor`, `exists`,
`text`, `pause`; targets are a CSS selector, `{ testid }` or
`{ text: <regex source>, sel?, within? }`. Keep each step's actions about as
long as its line; the recorder waits for the longer of the two.

Rules: never click a link that opens the system browser (hover it); never
type a real key (the api-keys take types a made-up one and removes it); never
arm anything live (the wallet-live take cancels both confirmations); the
wallet it generates lives in the tutorial profile and is never funded. Never
press a pump.fun "Create account" or "New wallet + account" (hover them), and
never press "Show token" on the AI page: its snippet is masked, the token is not.
