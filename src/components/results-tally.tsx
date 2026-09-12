import { formatNumber, formatPercent, percentValue } from '@/lib/format';
import { Badge, Card, cx } from './ui';

/**
 * Vote tally.
 *
 * FORM: magnitude across a small set of named categories, so a horizontal bar
 * chart sorted by value. Horizontal rather than vertical because option names
 * are player names and rule descriptions - they need a full text line, not a
 * rotated axis label.
 *
 * COLOR: one hue for every bar. The options are categories, but they all encode
 * the same measure, so this is a single-series chart. Giving each option its own
 * colour would imply an identity encoding that position and label already carry,
 * and tinting the leader differently would be colour-by-rank, which repaints the
 * chart whenever the count changes.
 *
 * LABELS: every bar carries its value and percentage inline. That is the
 * accessible, no-JavaScript equivalent of a hover tooltip, and with fewer than a
 * dozen bars there is no clutter cost - so no tooltip layer is added here.
 *
 * PERCENTAGES are a share of ballots, never of selections. See ResultsService.
 */

export type TallyRow = {
  optionId: string;
  name: string;
  description?: string | null;
  votes: number;
  isActive?: boolean;
};

export function ResultsTally({
  rows,
  totalBallots,
  isMultipleChoice = false,
  showRank = true,
  className,
}: {
  rows: readonly TallyRow[];
  totalBallots: number;
  isMultipleChoice?: boolean;
  showRank?: boolean;
  className?: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">No options to report on yet.</p>;
  }

  const leader = Math.max(...rows.map((row) => row.votes));

  return (
    <div className={cx('space-y-3', className)}>
      {isMultipleChoice ? (
        <p className="text-xs text-muted">
          Voters could pick more than one option, so the percentages are the share of ballots that
          included each option and add up to more than 100%.
        </p>
      ) : null}

      <ol className="space-y-3">
        {rows.map((row, index) => {
          const share = percentValue(row.votes, totalBallots);
          // Bars are scaled against the leader so a close race is readable;
          // the printed percentage is always the true share of ballots.
          const barWidth = leader > 0 ? (row.votes / leader) * 100 : 0;

          return (
            <li key={row.optionId} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  {showRank ? (
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-faint">
                      {index + 1}
                    </span>
                  ) : null}
                  <span className="truncate font-semibold">{row.name}</span>
                  {row.isActive === false ? <Badge tone="neutral">Withdrawn</Badge> : null}
                </div>

                <div className="shrink-0 text-sm tabular-nums">
                  <span className="font-bold">{formatNumber(row.votes)}</span>
                  <span className="text-muted"> · {formatPercent(row.votes, totalBallots)}</span>
                </div>
              </div>

              <div
                className="tally-track"
                role="img"
                aria-label={`${row.name}: ${formatNumber(row.votes)} votes, ${formatPercent(
                  row.votes,
                  totalBallots,
                )} of ballots`}
                title={`${formatNumber(row.votes)} of ${formatNumber(totalBallots)} ballots`}
              >
                <div
                  className="tally-fill bg-accent"
                  style={{
                    // A hairline stays visible at 0 so an option with no votes
                    // still reads as a bar rather than as missing data.
                    width: `${Math.max(barWidth, row.votes > 0 ? 2 : 0)}%`,
                  }}
                />
              </div>

              {row.description ? (
                <p className="text-xs text-muted">{row.description}</p>
              ) : null}

              <span className="sr-only">{share.toFixed(1)} percent</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Compact tally for dashboard cards: top options only, no descriptions. */
export function MiniTally({
  rows,
  totalBallots,
  limit = 3,
}: {
  rows: readonly TallyRow[];
  totalBallots: number;
  limit?: number;
}) {
  const visible = rows.slice(0, limit);

  return (
    <div className="space-y-2">
      {visible.map((row) => (
        <div key={row.optionId} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate">{row.name}</span>
            <span className="shrink-0 tabular-nums text-muted">
              {formatPercent(row.votes, totalBallots)}
            </span>
          </div>
          <div className="tally-track h-1.5">
            <div
              className="tally-fill bg-accent"
              style={{ width: `${percentValue(row.votes, totalBallots)}%` }}
            />
          </div>
        </div>
      ))}
      {rows.length > limit ? (
        <p className="text-xs text-faint">+{rows.length - limit} more</p>
      ) : null}
    </div>
  );
}

/**
 * Table view of the same numbers.
 *
 * Always available alongside the chart, collapsed by default. This is what makes
 * the visualisation accessible to a screen reader, copy-pasteable into a Discord
 * announcement, and readable in forced-colours mode.
 */
export function TallyTable({
  rows,
  totalBallots,
}: {
  rows: readonly TallyRow[];
  totalBallots: number;
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium text-muted hover:text-ink">
        View as a table
      </summary>
      <Card className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-faint">
              <th scope="col" className="px-4 py-2 font-semibold">
                Option
              </th>
              <th scope="col" className="px-4 py-2 text-right font-semibold">
                Votes
              </th>
              <th scope="col" className="px-4 py-2 text-right font-semibold">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.optionId} className="border-b border-line last:border-0">
                <th scope="row" className="px-4 py-2 text-left font-medium">
                  {row.name}
                </th>
                <td className="px-4 py-2 text-right tabular-nums">{formatNumber(row.votes)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted">
                  {formatPercent(row.votes, totalBallots)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </details>
  );
}
