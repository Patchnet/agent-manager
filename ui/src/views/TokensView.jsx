import { useApi, useInterval } from "../lib/api.js";
import { formatCost, formatTokenCount, totalTokens } from "../lib/format.js";

// The token windows carry lane 1's semantics verbatim: the widest row is every
// session log ever parsed — spend already incurred, not a remaining balance.
// Restating that here (not just in the CLI) is the whole point of the surface.
const FOOTNOTE =
  "Sums every session log found under the provider roots — spend already incurred, " +
  "not a balance. Subscription plans do not expose remaining quota, and models " +
  "without a rate table entry are counted but not priced.";

function WindowCard({ row }) {
  return (
    <div className="card window-card">
      <div className="label">{row.label}</div>
      <p className="value">{formatTokenCount(totalTokens(row))}</p>
      <div className="sub">
        {formatCost(row.cost)}
        {row.unpriced ? ` · ${formatTokenCount(row.unpriced)} unpriced` : ""}
        {" · "}
        {row.records.toLocaleString("en-US")} records
      </div>
    </div>
  );
}

function Breakdown({ title, rows, limit = 10 }) {
  const visible = [...(rows || [])]
    .sort((left, right) => totalTokens(right) - totalTokens(left))
    .slice(0, limit);
  if (!visible.length) return null;
  return (
    <div className="card">
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      <table className="token-table">
        <thead>
          <tr>
            <th>{title}</th>
            <th>In</th>
            <th>Out</th>
            <th>Cache</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.key}>
              <td className="title-cell">{row.key}</td>
              <td>{formatTokenCount(row.input)}</td>
              <td>{formatTokenCount(row.output)}</td>
              <td>{formatTokenCount((row.cacheRead || 0) + (row.cacheWrite || 0))}</td>
              <td>{formatCost(row.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TokensView() {
  // Token logs change on harness activity, not on run state, so this view has
  // its own slow refresh rather than riding the run event stream.
  const tick = useInterval(60_000);
  const { data, error, loading } = useApi("/api/tokens", tick);

  if (loading && !data) return <div className="subtle">Reading harness logs…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  if (data && data.available === false) {
    return (
      <div className="empty">
        <strong>Token usage unavailable</strong>
        {data.error}
      </div>
    );
  }

  const rows = data?.windows?.rows || [];

  return (
    <>
      <div className="section-head">
        <h2>Logged usage</h2>
        <span className="hint">
          {data?.windows
            ? `${data.windows.earliest} → ${data.windows.latest} (UTC days)`
            : "no usage in window"}
        </span>
      </div>

      {rows.length ? (
        <div className="window-grid">
          {rows.map((row) => (
            <WindowCard key={row.key} row={row} />
          ))}
        </div>
      ) : (
        <div className="empty">
          <strong>No usage logged yet</strong>
          Nothing parsed under the configured provider roots.
        </div>
      )}

      <div className="two-col">
        <Breakdown title="By model" rows={data?.byModel} />
        <Breakdown title="By repo" rows={data?.byRepo} />
      </div>

      {data?.warnings?.length ? (
        <p className="footnote">
          {data.warnings.map((warning, index) => (
            <span key={index}>
              {typeof warning === "string" ? warning : warning.message || JSON.stringify(warning)}
              <br />
            </span>
          ))}
        </p>
      ) : null}

      <p className="footnote">{FOOTNOTE}</p>
    </>
  );
}
