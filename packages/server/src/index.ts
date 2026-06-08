// Bun HTTP + WebSocket server. Hosts a single shared Radio; every connected
// browser subscribes to the "radio" topic and receives JSON status + binary
// FFT/audio frames. The dongle starts on the first client and stops when the
// last one leaves. In dev the Vite server proxies /ws here.

import type { Server, ServerWebSocket } from "bun";
import type { ClientMessage } from "@sdr/shared";
import { Radio } from "./session";

const PORT = Number(process.env.PORT ?? 8787);
const TOPIC = "radio";

let server: Server<undefined>;
let clientCount = 0;

const radio = new Radio({
  json: (msg) => server?.publish(TOPIC, JSON.stringify(msg)),
  binary: (buf) => server?.publish(TOPIC, buf),
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
      return Response.json({ ok: true, clients: clientCount });
    }
    return new Response("sdr server — connect a client to /ws", {
      headers: { "content-type": "text/plain" },
    });
  },
  websocket: {
    perMessageDeflate: false,
    open(ws: ServerWebSocket<undefined>) {
      ws.subscribe(TOPIC);
      clientCount++;
      // Sync the newcomer with current state, then ensure the radio is running.
      const info = radio.getDeviceInfo();
      if (info) ws.send(JSON.stringify({ type: "deviceInfo", info }));
      ws.send(JSON.stringify({ type: "state", state: radio.getState() }));
      if (clientCount === 1) void radio.start();
    },
    message(_ws, message) {
      if (typeof message !== "string") return;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(message) as ClientMessage;
      } catch {
        return;
      }
      radio.handle(msg);
    },
    close(ws: ServerWebSocket<undefined>) {
      ws.unsubscribe(TOPIC);
      clientCount = Math.max(0, clientCount - 1);
      if (clientCount === 0) radio.stop();
    },
  },
});

console.log(`[sdr] server listening on http://localhost:${PORT} (ws: /ws)`);
