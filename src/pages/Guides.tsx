// Guides (2026-10-25): the tutorial videos, each with its narration written
// out as the guide. One is open at a time; the rest are cards below it.
// The videos are the app's own screens with Krypt Voice over them
// (shared/guides/videos.ts, scripts/tutorials/README.md).

import { useEffect, useState } from 'react';
import { GUIDE_VIDEOS, QUICKSTART_VIDEO, VIDEO_CREDIT, fmtVideoDuration, isReady, videoUrls, type GuideVideo } from '@shared/guides/videos';
import { Play } from 'lucide-react';
import { Page } from '../components/common';
import { GuideVideoPlayer } from '../components/GuideVideoPlayer';
import { useNav } from '../state/nav';
import { cls } from '../utils/format';

export function GuidesPage() {
  const nav = useNav();
  const [id, setId] = useState<string>(nav.guide ?? QUICKSTART_VIDEO);
  useEffect(() => {
    if (nav.guide) setId(nav.guide);
  }, [nav.guide]);
  const current: GuideVideo = GUIDE_VIDEOS.find((v) => v.id === id) ?? GUIDE_VIDEOS[0];
  const ready = GUIDE_VIDEOS.filter(isReady).length;

  return (
    <Page
      title="Guides"
      subtitle={`Short recordings of this app, narrated. ${ready === GUIDE_VIDEOS.length ? '' : `${ready} of ${GUIDE_VIDEOS.length} recorded so far; the rest are written out.`}`}
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div data-testid="guides-current">
          <h2 className="text-[18px] font-semibold text-white">{current.title}</h2>
          <p className="mt-1 text-note text-krypt-muted">{current.description}</p>
          <GuideVideoPlayer key={current.id} video={current} className="mt-4" />
        </div>

        <aside className="space-y-2" data-testid="guides-list">
          <div className="text-label font-semibold uppercase tracking-label text-krypt-muted">All guides</div>
          {GUIDE_VIDEOS.map((v) => (
            <GuideCard key={v.id} video={v} active={v.id === current.id} onOpen={() => setId(v.id)} />
          ))}
          <p className="pt-3 text-label leading-relaxed text-krypt-muted/70">{VIDEO_CREDIT}</p>
        </aside>
      </div>
    </Page>
  );
}

function GuideCard({ video, active, onOpen }: { video: GuideVideo; active: boolean; onOpen: () => void }) {
  const ready = isReady(video);
  const [posterFailed, setPosterFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cls(
        'flex w-full items-center gap-3 rounded-xl border p-2 text-left transition',
        active ? 'border-accent/50 bg-accent/[0.08]' : 'border-white/8 bg-card hover:border-white/20',
      )}
      data-testid={`guide-card-${video.id}`}
      aria-current={active ? 'true' : undefined}
    >
      <span className="relative block h-14 w-24 shrink-0 overflow-hidden rounded-md bg-black">
        {ready && !posterFailed ? (
          <img src={videoUrls(video.id).poster} alt="" className="h-full w-full object-cover" onError={() => setPosterFailed(true)} />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-krypt-muted/60">
            <Play className="h-4 w-4" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-note font-medium text-white">{video.title}</span>
        <span className="block text-label text-krypt-muted">{ready ? fmtVideoDuration(video.durationSec) : 'Coming soon · written steps'}</span>
      </span>
    </button>
  );
}
