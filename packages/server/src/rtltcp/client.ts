// TCP client for rtl_tcp. Connects, parses the 12-byte RTL0 header, then streams
// IQ samples (interleaved uint8) which we normalize to interleaved float complex
// [I, Q, I, Q, ...] in [-1, 1). Also sends 5-byte control commands.

import type { Socket } from "bun";
import { RtlTcpCmd, encodeCommand } from "./commands";

export interface DongleHeader {
  tuner: number;
  gainCount: number;
}

export interface RtlTcpClientOptions {
  host: string;
  port: number;
}

export class RtlTcpClient {
  private socket: Socket | null = null;
  private headerBuf = new Uint8Array(0);
  private header: DongleHeader | null = null;
  // A trailing odd byte held back from the previous chunk to keep I/Q paired.
  private iqLeftover: number | null = null;

  private onHeaderCb?: (h: DongleHeader) => void;
  private onIqCb?: (iq: Float32Array) => void;
  private onRawIqCb?: (iq: Uint8Array) => void;
  private onCloseCb?: () => void;
  private onErrorCb?: (msg: string) => void;

  constructor(private readonly opts: RtlTcpClientOptions) {}

  onHeader(fn: (h: DongleHeader) => void) {
    this.onHeaderCb = fn;
  }
  onIq(fn: (iq: Float32Array) => void) {
    this.onIqCb = fn;
  }
  /** Raw post-header CU8 bytes, untouched — for consumers (rtl_433) that want
   *  the original interleaved uint8 stream rather than normalized floats. */
  onRawIq(fn: (iq: Uint8Array) => void) {
    this.onRawIqCb = fn;
  }
  onClose(fn: () => void) {
    this.onCloseCb = fn;
  }
  onError(fn: (msg: string) => void) {
    this.onErrorCb = fn;
  }

  /** Connects with a few retries (rtl_tcp may not be listening yet). */
  async connect(retries = 20, delayMs = 150): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.socket = await Bun.connect({
          hostname: this.opts.host,
          port: this.opts.port,
          socket: {
            data: (_s, data) => this.onData(data),
            close: () => this.onCloseCb?.(),
            error: (_s, err) => this.onErrorCb?.(err.message),
          },
        });
        return;
      } catch (err) {
        if (attempt >= retries) {
          throw new Error(
            `could not connect to rtl_tcp at ${this.opts.host}:${this.opts.port}: ${(err as Error).message}`,
          );
        }
        await Bun.sleep(delayMs);
      }
    }
  }

  close() {
    this.socket?.end();
    this.socket = null;
    this.iqLeftover = null;
  }

  private onData(chunk: Uint8Array) {
    let data = chunk;

    if (!this.header) {
      // Accumulate until we have the 12-byte header: "RTL0" + tuner + gainCount.
      const merged = new Uint8Array(this.headerBuf.length + data.length);
      merged.set(this.headerBuf);
      merged.set(data, this.headerBuf.length);
      if (merged.length < 12) {
        this.headerBuf = merged;
        return;
      }
      const dv = new DataView(merged.buffer, merged.byteOffset, 12);
      const magic = String.fromCharCode(
        merged[0]!,
        merged[1]!,
        merged[2]!,
        merged[3]!,
      );
      if (magic !== "RTL0") {
        this.onErrorCb?.(`unexpected rtl_tcp header magic: ${magic}`);
        return;
      }
      this.header = {
        tuner: dv.getUint32(4, false),
        gainCount: dv.getUint32(8, false),
      };
      this.headerBuf = new Uint8Array(0);
      this.onHeaderCb?.(this.header);
      data = merged.subarray(12);
    }

    // Hand the raw CU8 bytes to any raw consumer (rtl_433) before normalizing.
    if (data.length > 0) this.onRawIqCb?.(data);

    if (data.length === 0 || !this.onIqCb) return;

    // Normalize uint8 IQ -> interleaved float complex in [-1, 1). TCP does not
    // preserve message boundaries and a chunk (or the post-header remainder) can
    // be odd-length, which would split an I/Q pair and swap I/Q for the rest of
    // the stream. Carry any trailing odd byte to the next chunk so we only ever
    // emit whole pairs and the I/Q phase stays aligned.
    const carry = this.iqLeftover !== null ? 1 : 0;
    const total = carry + data.length;
    const pairBytes = total - (total & 1); // largest even count <= total
    if (pairBytes > 0) {
      const out = new Float32Array(pairBytes);
      let oi = 0;
      if (carry) out[oi++] = (this.iqLeftover! - 127.5) / 127.5;
      for (let i = 0; oi < pairBytes; i++) out[oi++] = (data[i]! - 127.5) / 127.5;
      this.onIqCb(out);
    }
    this.iqLeftover = total & 1 ? data[data.length - 1]! : null;
  }

  // --- control commands ---
  private send(cmd: RtlTcpCmd, param: number) {
    if (!this.socket) return;
    this.socket.write(encodeCommand(cmd, param));
  }
  setFrequency(hz: number) {
    this.send(RtlTcpCmd.SET_FREQUENCY, Math.round(hz));
  }
  setSampleRate(hz: number) {
    this.send(RtlTcpCmd.SET_SAMPLE_RATE, Math.round(hz));
  }
  setTunerGainMode(manual: boolean) {
    this.send(RtlTcpCmd.SET_TUNER_GAIN_MODE, manual ? 1 : 0);
  }
  setGainTenthDb(tenthDb: number) {
    this.send(RtlTcpCmd.SET_GAIN, Math.round(tenthDb));
  }
  setTunerGainByIndex(index: number) {
    this.send(RtlTcpCmd.SET_TUNER_GAIN_BY_INDEX, index);
  }
  setFreqCorrection(ppm: number) {
    this.send(RtlTcpCmd.SET_FREQ_CORRECTION, ppm);
  }
  setAgcMode(on: boolean) {
    this.send(RtlTcpCmd.SET_AGC_MODE, on ? 1 : 0);
  }
  setDirectSampling(value: number) {
    this.send(RtlTcpCmd.SET_DIRECT_SAMPLING, value);
  }
  setBiasTee(on: boolean) {
    this.send(RtlTcpCmd.SET_BIAS_TEE, on ? 1 : 0);
  }
}
