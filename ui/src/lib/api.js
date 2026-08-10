import { useCallback, useEffect, useRef, useState } from "react";

// Data access for the read-only API. Every hook here is a reader: there is no
// POST/PUT anywhere in this app, and the server would reject one anyway.

async function getJson(path, signal) {
  const response = await fetch(path, { signal, headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch a JSON endpoint, refetching whenever `revision` changes.
 *
 * The live SSE stream bumps a revision counter rather than carrying full
 * payloads, so the views stay driven by one fetch path instead of merging two
 * differently-shaped sources.
 */
export function useApi(path, revision = 0) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seen = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    // Only the first load shows a spinner; refreshes swap data in place so the
    // board does not flash on every status write.
    if (!seen.current) setState((prev) => ({ ...prev, loading: true }));
    getJson(path, controller.signal)
      .then((data) => {
        if (cancelled) return;
        seen.current = true;
        setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (cancelled || error.name === "AbortError") return;
        setState((prev) => ({ data: prev.data, error: error.message, loading: false }));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [path, revision]);

  return state;
}

/**
 * Subscribe to the server's change stream.
 *
 * Returns a monotonically increasing revision plus the latest lightweight run
 * summary, so a view can react instantly to state flips and still refetch the
 * full payload it actually renders.
 */
export function useLiveStream() {
  const [revision, setRevision] = useState(0);
  const [live, setLive] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source;
    let retry;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource("/api/events");
      source.addEventListener("open", () => setConnected(true));
      source.addEventListener("runs", (event) => {
        try {
          setLive(JSON.parse(event.data));
        } catch {
          // a malformed frame should not kill the stream
        }
        setRevision((value) => value + 1);
      });
      source.addEventListener("error", () => {
        setConnected(false);
        // EventSource retries on its own, but a server restart closes the
        // socket for good — rebuild it behind a short backoff.
        if (source.readyState === EventSource.CLOSED && !closed) {
          source.close();
          retry = setTimeout(connect, 2000);
        }
      });
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  return { revision, live, connected };
}

/** Poll-driven refresh for views with no push signal (tokens). */
export function useInterval(ms) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return tick;
}

export function useRunDetail(runId, revision) {
  const [state, setState] = useState({ data: null, error: null });

  const load = useCallback(
    (signal) => {
      if (!runId) {
        setState({ data: null, error: null });
        return Promise.resolve();
      }
      return getJson(`/api/runs/${encodeURIComponent(runId)}`, signal)
        .then((data) => setState({ data, error: null }))
        .catch((error) => {
          if (error.name === "AbortError") return;
          setState({ data: null, error: error.message });
        });
    },
    [runId],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, revision]);

  return state;
}
