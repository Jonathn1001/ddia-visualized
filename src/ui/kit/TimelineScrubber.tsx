import { btn } from './classes';

/** Hybrid snapshot+replay scrubbing UI over TimelineRecorder (DESIGN_PLAN §5). */
export function TimelineScrubber({
  processed,
  pending,
  running,
  onPlayPause,
  onStep,
  onScrub,
}: {
  processed: number;
  pending: number;
  running: boolean;
  onPlayPause: () => void;
  onStep: () => void;
  onScrub: (index: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <button className={btn} onClick={onPlayPause}>
        {running ? 'pause' : 'play'}
      </button>
      <button className={btn} onClick={onStep} disabled={running}>
        step
      </button>
      <input
        type="range"
        min={0}
        max={processed + pending}
        value={processed}
        disabled={running}
        onChange={(e) => onScrub(Number(e.target.value))}
        className="grow"
      />
      <span className="font-mono text-xs w-16 text-right">{processed}</span>
    </div>
  );
}
