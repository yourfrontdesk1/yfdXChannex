type Night = { date: string; sold: number; units: number; price: number | null };

/**
 * Two small charts on one date axis: how full the building is, and what it is
 * asking. They are separate plots rather than two scales on one, because a
 * count of apartments and a price in pounds share no axis and pretending they
 * do is the commonest way a chart lies.
 */
export default function NightsChart({ nights }: { nights: Night[] }) {
  if (nights.length === 0) return null;

  const W = 960;
  const PAD_L = 34;
  const PAD_R = 12;
  const OCC_H = 92;
  const GAP = 34;
  const PRICE_H = 92;
  const H = OCC_H + GAP + PRICE_H + 22;

  const plotW = W - PAD_L - PAD_R;
  const step = plotW / nights.length;
  const barW = Math.max(3, step - 3);

  const units = nights[0]?.units || 1;
  const prices = nights.map((n) => n.price).filter((p): p is number => p !== null);
  const lo = prices.length ? Math.min(...prices) : 0;
  const hi = prices.length ? Math.max(...prices) : 1;
  const span = hi - lo || 1;
  const priceY = (p: number) => OCC_H + GAP + PRICE_H - ((p - lo) / span) * (PRICE_H - 14) - 7;

  const line = nights
    .map((n, i) => (n.price === null ? null : `${PAD_L + i * step + barW / 2},${priceY(n.price)}`))
    .filter(Boolean)
    .join(" ");

  const label = (d: string) => `${d.slice(8)}/${d.slice(5, 7)}`;

  return (
    <div className="scroller">
      <svg viewBox={`0 0 ${W} ${H}`} className="nights" role="img"
           aria-label={`Apartments sold and average price for the next ${nights.length} nights`}>
        <text x="0" y="10" className="ax">{units}</text>
        <text x="0" y={OCC_H} className="ax">0</text>
        <line x1={PAD_L} y1={OCC_H} x2={W - PAD_R} y2={OCC_H} className="rule" />

        {nights.map((n, i) => {
          const h = (n.sold / units) * (OCC_H - 8);
          const full = n.sold >= units;
          return (
            <rect key={n.date} x={PAD_L + i * step} y={OCC_H - h} width={barW} height={Math.max(h, 0)}
                  rx="2" className={full ? "bar full" : "bar"}>
              <title>{`${n.date}: ${n.sold} of ${units} sold${n.price ? `, £${Math.round(n.price)}` : ""}`}</title>
            </rect>
          );
        })}

        <text x="0" y={priceY(hi) + 4} className="ax">{`£${Math.round(hi)}`}</text>
        <text x="0" y={priceY(lo) + 4} className="ax">{`£${Math.round(lo)}`}</text>
        <polyline points={line} className="pline" />
        {nights.map((n, i) =>
          n.price === null ? null : (
            <circle key={n.date} cx={PAD_L + i * step + barW / 2} cy={priceY(n.price)} r="2.4" className="pdot">
              <title>{`${n.date}: £${Math.round(n.price)}`}</title>
            </circle>
          ),
        )}

        {nights.map((n, i) =>
          i % 4 === 0 ? (
            <text key={n.date} x={PAD_L + i * step + barW / 2} y={H - 4} className="ax mid">{label(n.date)}</text>
          ) : null,
        )}
      </svg>
    </div>
  );
}
