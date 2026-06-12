// Supervises rtl_tcp as one unit: the child process (RtlTcpManager) plus our
// TCP client (RtlTcpClient). A dongle/rtl_tcp failure while the radio should
// be running triggers automatic restarts with exponential backoff (1s, 2s,
// 4s … capped), giving up after a few attempts so a genuinely unplugged dongle
// doesn't loop forever.

import type { DongleHeader } from "./client";
import { RtlTcpClient } from "./client";
import { RtlTcpManager } from "./manager";

const RECONNECT_MAX_ATTEMPTS = 6;
const RECONNECT_MAX_DELAY_MS = 15_000;

export interface RtlTcpConnectionEvents {
  /** Header parsed on a fresh connection — the receiver is live. */
  onUp(header: DongleHeader): void;
  /**
   * The connection went down: "exit" when the rtl_tcp process itself died (any
   * cached device info is stale), "close" for a TCP-only drop. Reconnects are
   * handled internally; this is for state bookkeeping only.
   */
  onDown(kind: "exit" | "close"): void;
  onIq(iq: Float32Array): void;
  onRawIq(bytes: Uint8Array): void;
  /** Operational errors and reconnect progress, for the client error banner. */
  onError(message: string): void;
}

export class RtlTcpConnection {
  private manager = new RtlTcpManager();
  private _client: RtlTcpClient | null = null;
  private up = false;
  private starting = false;
  private stopping = false;
  // True between start() and stop(): the radio *should* be running, so an
  // unexpected rtl_tcp exit or TCP drop schedules an automatic reconnect.
  private desired = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  constructor(private events: RtlTcpConnectionEvents) {
    this.manager.on((e) => {
      if (e.type === "log") console.log(`[rtl_tcp] ${e.line}`);
      else if (e.type === "exit") {
        this._client?.close();
        this._client = null;
        this.up = false;
        this.starting = false;
        // Don't reconnect after a stop we initiated (e.g. last client left).
        const expected = this.stopping;
        this.stopping = false;
        this.events.onDown("exit");
        if (!expected) this.scheduleReconnect(e.reason);
      }
    });
  }

  /** The live TCP client for control commands, or null while down. */
  get client(): RtlTcpClient | null {
    return this._client;
  }

  async start() {
    this.desired = true;
    this.reconnectAttempts = 0;
    this.clearReconnect();
    await this.ensureStarted();
  }

  stop() {
    this.desired = false;
    this.clearReconnect();
    this.stopping = true;
    this._client?.close();
    this._client = null;
    this.up = false;
    this.starting = false;
    this.manager.stop();
  }

  private async ensureStarted() {
    if (this.up || this.starting) return;
    this.starting = true;
    await this.manager.start();
    // rtl_tcp logs "listening..." to block-buffered stdout, so we don't wait
    // for it — just connect, retrying until the TCP socket accepts.
    await this.connectClient();
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** After an unexpected rtl_tcp exit / TCP drop, retry with backoff. */
  private scheduleReconnect(reason: string) {
    if (!this.desired || this.reconnectTimer) return;
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.desired = false;
      this.events.onError(
        `${reason} — gave up after ${RECONNECT_MAX_ATTEMPTS} reconnect attempts; check the dongle and press start`,
      );
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      1000 * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts++;
    this.events.onError(
      `${reason} — reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureStarted();
    }, delay);
  }

  private async connectClient() {
    const client = new RtlTcpClient({
      host: this.manager.host,
      port: this.manager.port,
    });
    client.onHeader((h) => {
      this.up = true;
      this.starting = false;
      this.reconnectAttempts = 0; // healthy connection — reset the backoff
      this.events.onUp(h);
    });
    client.onIq((iq) => this.events.onIq(iq));
    client.onRawIq((bytes) => this.events.onRawIq(bytes));
    client.onError((msg) => this.events.onError(msg));
    client.onClose(() => {
      // Ignore closes from a superseded client (a reconnect already replaced it).
      if (this._client && this._client !== client) return;
      this.up = false;
      this.events.onDown("close");
      // The rtl_tcp process may still be alive (TCP-only drop) — ensureStarted
      // skips the spawn in that case and just redials the socket.
      this.scheduleReconnect("lost connection to rtl_tcp");
    });
    try {
      await client.connect();
      this._client = client;
    } catch (err) {
      this.starting = false;
      this.events.onError((err as Error).message);
      this.scheduleReconnect("could not connect to rtl_tcp");
    }
  }
}
