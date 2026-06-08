// Spawns and supervises the `rtl_tcp` child process. rtl_tcp opens the USB
// dongle and exposes a single-client TCP server that streams IQ and accepts
// control commands. We run exactly one rtl_tcp and connect to it ourselves
// (RtlTcpClient), then fan out to all WebSocket clients.

import type { Subprocess } from "bun";

export interface RtlTcpManagerOptions {
  binary?: string; // path to rtl_tcp (default: "rtl_tcp" on PATH)
  host?: string;
  port?: number;
  deviceIndex?: number;
}

export type ManagerEvent =
  | { type: "log"; line: string }
  | { type: "ready" } // rtl_tcp is listening for a client
  | { type: "exit"; code: number | null; reason: string };

export class RtlTcpManager {
  readonly host: string;
  readonly port: number;
  private readonly binary: string;
  private readonly deviceIndex: number;
  private proc: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private listeners = new Set<(e: ManagerEvent) => void>();
  private ready = false;

  constructor(opts: RtlTcpManagerOptions = {}) {
    this.binary = opts.binary ?? "rtl_tcp";
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 1234;
    this.deviceIndex = opts.deviceIndex ?? 0;
  }

  on(fn: (e: ManagerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ManagerEvent) {
    if (e.type === "ready") this.ready = true;
    for (const fn of this.listeners) fn(e);
  }

  isRunning(): boolean {
    return this.proc != null && this.proc.killed === false;
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Best-effort: kill orphaned rtl_tcp instances from previous (unclean) runs
   * so they release the single USB device before we spawn our own. Safe for a
   * single-dongle dev tool; it does nothing on platforms without pkill.
   */
  private async preflightCleanup(): Promise<void> {
    try {
      const p = Bun.spawn(["pkill", "-f", "rtl_tcp"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      await p.exited;
      // Give the USB stack a moment to release the device.
      await Bun.sleep(300);
    } catch {
      // pkill missing or nothing to kill — fine.
    }
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    this.ready = false;
    await this.preflightCleanup();
    const args = [
      this.binary,
      "-a",
      this.host,
      "-p",
      String(this.port),
      "-d",
      String(this.deviceIndex),
    ];
    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      this.emit({
        type: "exit",
        code: null,
        reason: `failed to spawn ${this.binary}: ${(err as Error).message}`,
      });
      return;
    }
    this.proc = proc;
    // rtl_tcp logs everything (device info, "listening...") to stderr.
    this.pipeLines(proc.stderr);
    this.pipeLines(proc.stdout);
    proc.exited.then((code) => {
      this.proc = null;
      this.ready = false;
      this.emit({
        type: "exit",
        code,
        reason: code === 0 ? "rtl_tcp exited" : `rtl_tcp exited (code ${code})`,
      });
    });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.ready = false;
  }

  private async pipeLines(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buf = "";
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line.length === 0) continue;
          this.emit({ type: "log", line });
          // rtl_tcp prints "listening..." once the TCP server is up.
          if (/listening/i.test(line)) this.emit({ type: "ready" });
        }
      }
    } catch {
      // stream closed on process exit; ignore.
    }
  }
}
