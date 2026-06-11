// Bun HTTP + WebSocket server. Hosts a single shared Radio; every connected
// browser subscribes to the "radio" topic and receives JSON status + binary
// FFT/audio frames. The dongle starts on the first client and stops when the
// last one leaves. In dev the Vite server proxies /ws here.

import type { Server, ServerWebSocket } from "bun";
import { PROTOCOL_VERSION, parseClientMessage } from "@sdr/shared";
import { Radio } from "./session";
import { EMBEDDED, HAS_EMBEDDED } from "./embedded";

const PORT = Number(process.env.PORT ?? 8787);
const TOPIC = "radio";

let server: Server<undefined>;
const clients = new Set<ServerWebSocket<undefined>>();
let stopTimer: ReturnType<typeof setTimeout> | null = null;
// Grace period before stopping the dongle once the last client leaves — rides
// out React StrictMode remounts and page reloads without thrashing rtl_tcp.
const STOP_GRACE_MS = 2500;

// Binary frames (FFT + audio, ~260 KB/s) are disposable: a client that can't
// drain its socket gets frames skipped rather than queued without bound, so one
// stalled tab can't grow server memory until everyone's radio dies. ~2 s of
// stream; small JSON status messages still always go out via publish.
const MAX_BUFFERED_BYTES = 512 * 1024;

const radio = new Radio({
  json: (msg) => server?.publish(TOPIC, JSON.stringify(msg)),
  binary: (buf) => {
    for (const ws of clients) {
      if (ws.getBufferedAmount() < MAX_BUFFERED_BYTES) ws.send(buf);
    }
  },
});

server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return srv.upgrade(req)
        ? undefined
        : new Response("websocket upgrade failed", { status: 400 });
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, clients: clients.size });
    }
    // In a packaged binary, serve the embedded frontend; in dev this is empty
    // and Vite serves the app, proxying /ws here.
    const asset = staticResponse(url.pathname);
    if (asset) return asset;
    return new Response("sdr server — connect a client to /ws", {
      headers: { "content-type": "text/plain" },
    });
  },
  websocket: {
    perMessageDeflate: false,
    open(ws: ServerWebSocket<undefined>) {
      ws.subscribe(TOPIC);
      clients.add(ws);
      // A client returned within the grace period — cancel any pending stop.
      if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      // Version handshake first, then sync the newcomer with current state and
      // ensure the radio is running.
      ws.send(JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION }));
      const info = radio.getDeviceInfo();
      if (info) ws.send(JSON.stringify({ type: "deviceInfo", info }));
      ws.send(JSON.stringify({ type: "state", state: radio.getState() }));
      void radio.start(); // idempotent if already running/starting
    },
    message(_ws, message) {
      if (typeof message !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        console.warn(`[ws] dropping non-JSON message: ${preview(message)}`);
        return;
      }
      const msg = parseClientMessage(parsed);
      if (!msg) {
        console.warn(`[ws] dropping malformed message: ${preview(message)}`);
        return;
      }
      radio.handle(msg);
    },
    close(ws: ServerWebSocket<undefined>) {
      ws.unsubscribe(TOPIC);
      clients.delete(ws);
      if (clients.size === 0 && !stopTimer) {
        stopTimer = setTimeout(() => {
          stopTimer = null;
          if (clients.size === 0) radio.stop();
        }, STOP_GRACE_MS);
      }
    },
  },
});

const url = `http://localhost:${PORT}`;
console.log(`[sdr] server listening on ${url} (ws: /ws)`);

// Packaged binary: open the user's browser to the embedded UI on first launch.
if (HAS_EMBEDDED && !process.env.SDR_NO_OPEN) {
  console.log(`[sdr] opening ${url} …`);
  openBrowser(url);
}

/** Truncate a raw message for log output. */
function preview(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Serve an embedded frontend asset, with an SPA fallback to index.html. */
function staticResponse(pathname: string): Response | null {
  if (!HAS_EMBEDDED) return null;
  const key = pathname === "/" ? "/index.html" : pathname;
  let asset = EMBEDDED[key];
  // Unknown path with no file extension → client-side route; serve the shell.
  if (!asset && !key.slice(1).includes(".")) asset = EMBEDDED["/index.html"];
  if (!asset) return null;
  return new Response(Bun.file(asset.path), {
    headers: { "content-type": asset.type },
  });
}

/** Open a URL in the platform's default browser (best-effort). */
function openBrowser(target: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", target]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", target]
        : ["xdg-open", target];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no opener available — the user can navigate manually */
  }
}
