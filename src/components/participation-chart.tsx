'use client';

import { useMemo, useRef, useState } from 'react';
import { formatDateTimeLocal, formatNumber } from '@/lib/format';
import { cx } from './ui';

/**
 * Turnout over the voting period.
 *
 * FORM: change over time, one measure, so an area + line. Single series, so no
 * legend - the heading names it. One y-axis only; the cumulative and per-period
 * views are two framings of the same measure (ballots) and only one is shown at
 * a time, so this is never a dual-axis chart.
 *
 * MARKS: 2px line, area fill at low alpha beneath it, 8px hover marker with a
 * 2px surface ring so it stays legible over the fill. Grid lines are recessive
 * (the border token), values are only labelled where the pointer is - a number
 * on every point would be unreadable over a 48-hour election.
 *
 * COLOR: the same single accent hue as the tally, taken from the theme token, so
 * the dark palette is a *selected* dark step rather than an inverted light one.
 */

export type ParticipationDatum = { bucket: string; votes: number };

type Mode = 'cumulative' | 'perPeriod';

const VIEW = { width: 720, height: 240 };
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

const PLOT = {
  width: VIEW.width - PAD.left - PAD.right,
  height: VIEW.height - PAD.top - PAD.bottom,
};

/** Round a maximum up to a readable axis ceiling. */
function niceCeiling(value: number): number {
  if (value <= 5) return Math.max(1, value);

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;

  return step * magnitude;
}

export function ParticipationChart({
  data,
  className,
}: {
  data: readonly ParticipationDatum[];
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>('cumulative');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const series = useMemo(() => {
    if (mode === 'perPeriod') return data.map((point) => point.votes);

    let running = 0;
    return data.map((point) => {
      running += point.votes;
      return running;
    });
  }, [data, mode]);

  const maxValue = niceCeiling(Math.max(1, ...series));

  const points = useMemo(
    () =>
      series.map((value, index) => ({
        x:
          PAD.left +
          (series.length === 1 ? PLOT.width / 2 : (index / (series.length - 1)) * PLOT.width),
        y: PAD.top + PLOT.height - (value / maxValue) * PLOT.height,
        value,
      })),
    [series, maxValue],
  );

  if (data.length === 0) {
    return (
      <p className={cx('text-sm text-muted', className)}>
        No ballots have been cast yet, so there is nothing to chart.
      </p>
    );
  }

  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ');

  const baseline = PAD.top + PLOT.height;
  const first = points[0];
  const last = points[points.length - 1];
  const areaPath =
    first && last
      ? `${linePath} L${last.x},${baseline} L${first.x},${baseline} Z`
      : '';

  const gridValues = [0, 0.5, 1].map((fraction) => Math.round(maxValue * fraction));
  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredDatum = hoverIndex !== null ? data[hoverIndex] : null;

  /** Map a pointer position to the nearest data index. */
  function handlePointer(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;

    const bounds = svg.getBoundingClientRect();
    // The SVG scales with its container, so the pointer has to be converted
    // back into viewBox units before it means anything.
    const x = ((event.clientX - bounds.left) / bounds.width) * VIEW.width;

    const ratio = (x - PAD.left) / PLOT.width;
    const index = Math.round(ratio * Math.max(1, series.length - 1));

    setHoverIndex(Math.min(series.length - 1, Math.max(0, index)));
  }

  const totalBallots = data.reduce((sum, point) => sum + point.votes, 0);

  return (
    <div className={cx('space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">
          {formatNumber(totalBallots)} ballots across {data.length}{' '}
          {data.length === 1 ? 'period' : 'periods'}
        </p>

        <div
          className="inline-flex rounded-lg border border-line p-0.5"
          role="group"
          aria-label="Chart view"
        >
          {(
            [
              ['cumulative', 'Cumulative'],
              ['perPeriod', 'Per period'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              aria-pressed={mode === value}
              className={cx(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                mode === value ? 'bg-accent text-accent-ink' : 'text-muted hover:text-ink',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
          className="h-auto w-full touch-none"
          role="img"
          aria-label={`Turnout over time, ${mode === 'cumulative' ? 'cumulative' : 'per period'}. ${formatNumber(totalBallots)} ballots in total.`}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setHoverIndex(null)}
        >
          {/* Recessive gridlines and y-axis labels. */}
          {gridValues.map((value) => {
            const y = PAD.top + PLOT.height - (value / maxValue) * PLOT.height;

            return (
              <g key={value}>
                <line
                  x1={PAD.left}
                  x2={VIEW.width - PAD.right}
                  y1={y}
                  y2={y}
                  className="stroke-line"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-faint text-[11px] tabular-nums"
                >
                  {formatNumber(value)}
                </text>
              </g>
            );
          })}

          <path d={areaPath} className="fill-accent/15" />
          <path
            d={linePath}
            fill="none"
            className="stroke-accent"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Crosshair + marker for the hovered period. */}
          {hovered ? (
            <g>
              <line
                x1={hovered.x}
                x2={hovered.x}
                y1={PAD.top}
                y2={baseline}
                className="stroke-accent/40"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle
                cx={hovered.x}
                cy={hovered.y}
                r={5}
                className="fill-accent stroke-surface"
                strokeWidth={2}
              />
            </g>
          ) : null}

          {/* First and last time labels only; interior values come from hover. */}
          <text x={PAD.left} y={VIEW.height - 8} className="fill-faint text-[11px]">
            {shortLabel(data[0]?.bucket)}
          </text>
          {data.length > 1 ? (
            <text
              x={VIEW.width - PAD.right}
              y={VIEW.height - 8}
              textAnchor="end"
              className="fill-faint text-[11px]"
            >
              {shortLabel(data[data.length - 1]?.bucket)}
            </text>
          ) : null}
        </svg>

        {hovered && hoveredDatum ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop"
            style={{
              left: `${(hovered.x / VIEW.width) * 100}%`,
              top: `${(hovered.y / VIEW.height) * 100}%`,
            }}
          >
            <div className="font-semibold tabular-nums">
              {formatNumber(hovered.value)} {mode === 'cumulative' ? 'total' : 'this period'}
            </div>
            <div className="text-muted">
              <LocalBucketLabel value={hoveredDatum.bucket} />
            </div>
          </div>
        ) : null}
      </div>

      <details>
        <summary className="cursor-pointer text-sm font-medium text-muted hover:text-ink">
          View as a table
        </summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-card border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2">
              <tr className="text-left text-xs uppercase tracking-wide text-faint">
                <th scope="col" className="px-3 py-2 font-semibold">
                  Period
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Ballots
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Running total
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((point, index) => (
                <tr key={point.bucket} className="border-t border-line">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal">
                    <LocalBucketLabel value={point.bucket} />
                  </th>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {formatNumber(point.votes)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted">
                    {formatNumber(
                      data.slice(0, index + 1).reduce((sum, entry) => sum + entry.votes, 0),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

/** Axis label: month/day, short enough not to collide at either end. */
function shortLabel(iso: string | undefined): string {
  if (!iso) return '';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

/** Client-only local rendering; this whole component is already client-side. */
function LocalBucketLabel({ value }: { value: string }) {
  return <>{formatDateTimeLocal(value)}</>;
}
