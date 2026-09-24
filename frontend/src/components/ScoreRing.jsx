import { useEffect, useState } from 'react';
import { scoreColor, scoreTextColor } from '@/lib/scoreColors';

// Circular score ring matching the sample report. Score 0-100.
export default function ScoreRing({ score = 0, size = 168, stroke = 14, animate = true }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const ringColor = scoreColor(score);
  const textColor = scoreTextColor(score);

  const [shown, setShown] = useState(animate ? 0 : score);
  useEffect(() => {
    if (!animate) { setShown(score); return; }
    let raf;
    const start = performance.now();
    const from = 0;
    const dur = 900;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from + (score - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [score, animate]);

  const shownPct = Math.max(0, Math.min(100, shown)) / 100;
  const shownOffset = c * (1 - shownPct);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <div
        className="absolute inset-3 rounded-full blur-2xl opacity-25 transition-colors duration-700"
        style={{ background: ringColor }}
      />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="relative">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ringColor}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={shownOffset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset 0.3s linear' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tnum font-heading text-5xl font-800 leading-none" style={{ color: textColor }}>{Math.round(shown)}</span>
        <span className="mt-1 text-xs font-500 uppercase tracking-wide text-muted-foreground">out of 100</span>
      </div>
    </div>
  );
}
