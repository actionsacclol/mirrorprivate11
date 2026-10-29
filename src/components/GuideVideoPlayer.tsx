// A tutorial video (shared/guides/videos.ts) with its captions drawn by us
// (2026-10-25): the narration lines and their cue times are in the manifest,
// so no <track> is needed — and the lines double as a clickable transcript.
// The poster shows until first play; then the native controls.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Captions, CaptionsOff, Play } from 'lucide-react';
import { GUIDE_VIDEOS, cueAt, fmtVideoDuration, isReady, videoUrls, type GuideVideo } from '@shared/guides/videos';
import { cls } from '../utils/format';

const RATES = [1, 1.25, 1.5] as const;

export function guideById(id: string): GuideVideo | null {
  return GUIDE_VIDEOS.find((v) => v.id === id) ?? null;
}

export function GuideVideoPlayer({
  video,
  autoPlay = false,
  transcript = true,
  className,
}: {
  video: GuideVideo;
  autoPlay?: boolean;
  /** Show the numbered lines under the player (the written guide). */
  transcript?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(autoPlay);
  const [captions, setCaptions] = useState(true);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const [line, setLine] = useState(-1);
  const [failed, setFailed] = useState(false);
  const ready = isReady(video);
  const urls = videoUrls(video.id);

  useEffect(() => {
    setStarted(autoPlay);
    setLine(-1);
    setFailed(false);
  }, [video.id, autoPlay]);

  useEffect(() => {
    const el = ref.current;
    if (el) el.playbackRate = rate;
  }, [rate, started]);

  const play = useCallback(() => {
    setStarted(true);
    // The element mounts with the poster gone; play once it exists.
    requestAnimationFrame(() => void ref.current?.play().catch(() => undefined));
  }, []);

  const seekTo = (i: number): void => {
    const cue = video.cues[i];
    if (!cue) return;
    if (!started) setStarted(true);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.currentTime = Math.max(0, cue[0] - 0.15);
      void el.play().catch(() => undefined);
    });
  };

  return (
    <div className={className}>
      <div className="relative overflow-hidden rounded-xl border border-white/8 bg-black" style={{ aspectRatio: '16 / 9' }} data-testid="guide-player">
        {!ready ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="text-note font-semibold text-white">Coming soon</span>
            <span className="text-body text-krypt-muted">This guide is not recorded yet. Its steps are written out below.</span>
          </div>
        ) : !started ? (
          <button type="button" onClick={play} className="group absolute inset-0 h-full w-full" aria-label={`Play ${video.title}`}>
            <img src={urls.poster} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/30 transition group-hover:bg-accent">
                <Play className="ml-1 h-7 w-7" />
              </span>
            </span>
            <span className="absolute bottom-3 right-3 rounded-md bg-black/70 px-2 py-0.5 font-mono text-label text-white">{fmtVideoDuration(video.durationSec)}</span>
          </button>
        ) : (
          <>
            <video
              ref={ref}
              src={urls.video}
              poster={urls.poster}
              preload="metadata"
              autoPlay
              playsInline
              controls
              controlsList="nodownload noremoteplayback"
              className="h-full w-full"
              onTimeUpdate={(e) => setLine(cueAt(video, e.currentTarget.currentTime))}
              onEnded={() => setLine(-1)}
              onError={() => setFailed(true)}
            />
            {captions && line >= 0 && (
              <div className="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center px-6">
                <span className="max-w-[80%] rounded-md bg-black/75 px-3 py-1.5 text-center text-[15px] leading-snug text-white shadow-soft">{video.lines[line]}</span>
              </div>
            )}
          </>
        )}
        {failed && (
          <div className="absolute inset-x-0 top-0 bg-down/80 px-3 py-1.5 text-center text-body text-white">
            This video could not be loaded. The files ship with the app under resources/guides/videos.
          </div>
        )}
      </div>

      {ready && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-body text-krypt-muted">
          <button
            type="button"
            onClick={() => setCaptions((c) => !c)}
            className={cls('inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition hover:bg-white/5 hover:text-white', captions && 'text-white')}
            title={captions ? 'Hide captions' : 'Show captions'}
          >
            {captions ? <Captions className="h-4 w-4" /> : <CaptionsOff className="h-4 w-4" />} Captions
          </button>
          <span className="ml-auto inline-flex rounded-md border border-white/10 p-0.5">
            {RATES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRate(r)}
                className={cls('rounded px-2 py-0.5 font-mono text-label transition', rate === r ? 'bg-raised text-white' : 'hover:text-white')}
              >
                {r}×
              </button>
            ))}
          </span>
        </div>
      )}

      {transcript && (
        <ol className="mt-4 space-y-1" data-testid="guide-transcript">
          {video.lines.map((t, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => (ready ? seekTo(i) : undefined)}
                disabled={!ready}
                className={cls(
                  'flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left text-note transition',
                  ready && 'hover:bg-white/5',
                  line === i ? 'bg-accent/[0.08] text-white' : 'text-krypt-muted',
                )}
              >
                <span className="mt-px w-5 shrink-0 text-right font-mono text-label text-krypt-muted/70">{i + 1}</span>
                <span className="flex-1 leading-relaxed">{t}</span>
                {ready && video.cues[i] && <span className="shrink-0 font-mono text-label text-krypt-muted/60">{fmtVideoDuration(Math.floor(video.cues[i][0]))}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/**
 * A one-line "Watch: …" row that opens the player in place — for the
 * onboarding card and other tight spots. Renders nothing for a guide that
 * is not recorded yet.
 */
export function InlineGuide({ id, label, className }: { id: string; label?: string; className?: string }) {
  const video = guideById(id);
  const [open, setOpen] = useState(false);
  if (!video || !isReady(video)) return null;
  if (open) return <GuideVideoPlayer video={video} autoPlay transcript={false} className={className} />;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={cls(
        'flex w-full items-center gap-3 rounded-md border border-krypt-purple/40 bg-krypt-purple/10 px-3 py-2.5 text-left transition hover:bg-krypt-purple/20',
        className,
      )}
      data-testid={`inline-guide-${id}`}
    >
      <Play className="h-5 w-5 flex-shrink-0 text-krypt-purple" />
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-white">{label ?? `Watch: ${video.title}`}</span>
        <span className="block text-label leading-relaxed text-krypt-muted">{video.description}</span>
      </span>
      <span className="font-mono text-label text-krypt-muted">{fmtVideoDuration(video.durationSec)}</span>
    </button>
  );
}
