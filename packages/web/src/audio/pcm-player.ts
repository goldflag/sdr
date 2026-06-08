// Main-thread side of the audio pipeline: feeds Int16 PCM frames to the
// AudioWorklet ring buffer and controls volume. AudioContext is created at the
// server's audio rate so no client-side resampling is needed.

import { AUDIO_RATE } from "@sdr/shared";
import workletUrl from "./pcm-worklet.js?url";

export class PcmPlayer {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private volume = 0.7;
  private ready = false;

  /** Must be called from a user gesture (browsers block autoplay). */
  async init(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ sampleRate: AUDIO_RATE });
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "pcm-player", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const gain = ctx.createGain();
    gain.gain.value = this.volume;
    node.connect(gain).connect(ctx.destination);
    this.ctx = ctx;
    this.node = node;
    this.gain = gain;
    this.ready = true;
    await ctx.resume();
  }

  get running(): boolean {
    return this.ready && this.ctx?.state === "running";
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  push(pcm: Int16Array) {
    if (!this.node) return;
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i]! / 32768;
    this.node.port.postMessage(f, [f.buffer]);
  }

  flush() {
    this.node?.port.postMessage("flush");
  }

  async close() {
    await this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.gain = null;
    this.ready = false;
  }
}
