'use client';

/**
 * Grouped bar chart for monthly revenue vs expenses.
 *
 * Inline SVG rather than a charting library: the shape is simple, and a
 * dependency would add far more weight than the ~80 lines it replaces. Colours
 * come from CSS custom properties so the chart follows the app's theme instead
 * of carrying its own palette.
 */
interface Point {
  label: string;
  revenue: number;
  expenses: number;
}

export function TrendChart({ data, currency }: { data: Point[]; currency: string }) {
  if (data.length === 0) return null;

  const height = 180;
  const barGroupWidth = 44;
  const barWidth = 16;
  const gap = 4;
  const paddingLeft = 8;
  const width = Math.max(data.length * barGroupWidth + paddingLeft, 320);

  const maxValue = Math.max(...data.flatMap((d) => [d.revenue, d.expenses]), 1);
  // Round the axis up to a clean number so gridlines read sensibly.
  const magnitude = 10 ** Math.floor(Math.log10(maxValue));
  const axisMax = Math.ceil(maxValue / magnitude) * magnitude;

  const scale = (value: number) => (value / axisMax) * (height - 24);

  const compact = (value: number) =>
    value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(1)}M`
      : value >= 1_000
        ? `${Math.round(value / 1_000)}k`
        : String(Math.round(value));

  const monthLabel = (iso: string) => {
    const [, month] = iso.split('-');
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return names[Number(month) - 1] ?? iso;
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-accent" />
          <span className="text-muted-foreground">Revenue</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-negative" />
          <span className="text-muted-foreground">Expenses</span>
        </span>
        <span className="ml-auto text-subtle-foreground">{currency}</span>
      </div>

      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height + 20}
          role="img"
          aria-label={`Monthly revenue and expenses in ${currency}`}
          className="min-w-full"
        >
          {/* Gridlines at quarters of the axis. */}
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const y = height - 24 - scale(axisMax * fraction) + 12;
            return (
              <g key={fraction}>
                <line
                  x1={paddingLeft}
                  x2={width}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                  strokeDasharray={fraction === 0 ? undefined : '2 3'}
                />
                <text
                  x={0}
                  y={y - 2}
                  className="fill-subtle-foreground text-[9px]"
                  style={{ fontSize: 9 }}
                >
                  {fraction === 0 ? '' : compact(axisMax * fraction)}
                </text>
              </g>
            );
          })}

          {data.map((point, index) => {
            const groupX = paddingLeft + index * barGroupWidth + 6;
            const baseline = height - 12;
            const revenueHeight = scale(point.revenue);
            const expenseHeight = scale(point.expenses);

            return (
              <g key={point.label}>
                <rect
                  x={groupX}
                  y={baseline - revenueHeight}
                  width={barWidth}
                  height={Math.max(revenueHeight, 1)}
                  rx={2}
                  className="fill-accent"
                >
                  <title>{`${monthLabel(point.label)} revenue: ${point.revenue.toLocaleString()}`}</title>
                </rect>
                <rect
                  x={groupX + barWidth + gap}
                  y={baseline - expenseHeight}
                  width={barWidth}
                  height={Math.max(expenseHeight, 1)}
                  rx={2}
                  className="fill-negative"
                >
                  <title>{`${monthLabel(point.label)} expenses: ${point.expenses.toLocaleString()}`}</title>
                </rect>
                <text
                  x={groupX + barWidth}
                  y={height + 4}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  style={{ fontSize: 10 }}
                >
                  {monthLabel(point.label)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
