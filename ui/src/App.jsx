import { useEffect, useState } from "react";
import { Mark } from "./components/Chip.jsx";
import { GoalsView } from "./views/GoalsView.jsx";
import { RunsView } from "./views/RunsView.jsx";
import { TokensView } from "./views/TokensView.jsx";
import { useApi, useLiveStream } from "./lib/api.js";

const TABS = [
  { id: "runs", label: "Runs" },
  { id: "goals", label: "Goals" },
  { id: "tokens", label: "Tokens" },
];

function currentTab() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  return TABS.some((tab) => tab.id === hash) ? hash : "runs";
}

export function App() {
  const [tab, setTab] = useState(currentTab);
  const { revision, live, connected } = useLiveStream();
  const health = useApi("/api/health", 0);

  // Hash routing keeps deep links working without pulling in a router.
  useEffect(() => {
    const sync = () => setTab(currentTab());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const select = (id) => {
    window.location.hash = `#/${id}`;
    setTab(id);
  };

  const attention = live?.counts?.blocked ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <Mark size={16} />
          Agent Manager
          <small>v{health.data?.version || "…"}</small>
        </span>

        <nav className="tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="tab"
              aria-current={tab === item.id}
              onClick={() => select(item.id)}
            >
              {item.label}
              {item.id === "runs" && attention ? (
                <span className="tab-count">{attention}</span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <span className="link-status" data-live={connected}>
            <i className="link-dot" />
            {connected ? "live" : "reconnecting"}
          </span>
          <span title="This dashboard never writes run state.">read-only</span>
        </div>
      </header>

      <main className="main">
        {tab === "runs" ? <RunsView revision={revision} live={live} /> : null}
        {tab === "goals" ? <GoalsView revision={revision} /> : null}
        {tab === "tokens" ? <TokensView /> : null}
      </main>
    </div>
  );
}
