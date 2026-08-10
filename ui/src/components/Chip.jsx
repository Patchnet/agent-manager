import { stateLabel, stateTone } from "../lib/format.js";

/** State chip. `live` states get a pulse so motion means motion, nothing else. */
export function Chip({ state, tone, children, pulse = false }) {
  const resolved = tone || stateTone(state);
  return (
    <span className="chip" data-tone={resolved}>
      {pulse && resolved === "live" ? <i className="pulse" aria-hidden="true" /> : null}
      {children ?? stateLabel(state)}
    </span>
  );
}

export function Mark({ size = 15 }) {
  const cell = size / 3.4;
  const gap = (size - cell * 3) / 2;
  const at = (index) => index * (cell + gap);
  const color = (row, column) => {
    if (row === 1 && column === 1) return "#d97757";
    return (row + column) % 2 === 1 ? "#3da8dc" : "#2a2620";
  };
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {[0, 1, 2].map((row) =>
        [0, 1, 2].map((column) => (
          <rect
            key={`${row}-${column}`}
            x={at(column)}
            y={at(row)}
            width={cell}
            height={cell}
            rx={cell * 0.28}
            fill={color(row, column)}
          />
        )),
      )}
    </svg>
  );
}

export function Bar({ numerator, denominator, tone = "live" }) {
  const value = denominator ? Math.max(0, Math.min(1, numerator / denominator)) : 0;
  return (
    <span
      className="bar"
      data-tone={tone}
      style={{ "--value": value }}
      role="img"
      aria-label={denominator ? `${numerator} of ${denominator} leaves delivered` : "no leaf goals"}
    />
  );
}
