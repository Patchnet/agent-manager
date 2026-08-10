# agent-manager dashboard (optional)

Self-contained Vite + React SPA for `agent-manager ui`. It has its own
`package.json` on purpose: **the core CLI gains no runtime dependency from
anything in this folder**, and the tool works exactly the same whether or not
this app was ever built.

```bash
cd ui
npm install
npm run build      # emits ui/dist, which agent-manager ui serves
```

Then run `agent-manager ui` from the repository root.

## Working on the UI

```bash
npm run dev        # http://127.0.0.1:5173, proxies /api to the running server
```

Keep `agent-manager ui` running in another terminal — the dev server only
serves the front end; all data comes from that process.

## Boundary

Read-only. There is no mutating endpoint to call, and the server rejects
anything other than `GET`/`HEAD`. State changes go through the CLI. If a
control belongs here, it belongs in `agent-manager` first.

`dist/` and `node_modules/` are gitignored; only source is tracked.
