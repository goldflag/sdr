// Records the demodulated-audio stream to a WAV file entirely in the browser.
// The same Int16 PCM frames that feed the speaker (see use-audio) are appended
// here while recording; stop() encodes them into a mono 16-bit PCM WAV blob.
// Independent of playback — you can record without having enabled audio output.

import { AUDIO_RATE } from "@sdr/shared";

export class WavRecorder {
  private chunks: Int16Array[] = [];
  private sampleRate = AUDIO_RATE;
  private total = 0;
  private active = false;

  get recording(): boolean {
    return this.active;
  }

  /** Recorded length so far, in seconds. */
  get durationSec(): number {
    return this.total / this.sampleRate;
  }

  /** Approximate size of the eventual WAV, in bytes (44-byte header + PCM). */
  get byteLength(): number {
    return 44 + this.total * 2;
  }

  start() {
    this.chunks = [];
    this.total = 0;
    this.active = true;
  }

  /** Append one audio frame. Frames are copied — the source buffer may be
   *  reused/transferred elsewhere in the pipeline. No-op unless recording. */
  push(pcm: Int16Array, sampleRate: number) {
    if (!this.active) return;
    this.sampleRate = sampleRate;
    this.chunks.push(pcm.slice());
    this.total += pcm.length;
  }

  /** Stop and return the recording as a WAV blob, or null if nothing was
   *  captured. Resets the buffer either way. */
  stop(): Blob | null {
    this.active = false;
    if (this.total === 0) {
      this.chunks = [];
      return null;
    }
    const blob = encodeWav(this.chunks, this.total, this.sampleRate);
    this.chunks = [];
    this.total = 0;
    return blob;
  }
}

/** Concatenate Int16 PCM chunks into a canonical mono 16-bit WAV file. */
function encodeWav(
  chunks: Int16Array[],
  samples: number,
  sampleRate: number,
): Blob {
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  dv.setUint32(16, 16, true); // PCM fmt chunk size
  dv.setUint16(20, 1, true); // audio format = PCM
  dv.setUint16(22, 1, true); // channels = mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate (sr * blockAlign)
  dv.setUint16(32, 2, true); // block align (channels * bytesPerSample)
  dv.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  dv.setUint32(40, dataBytes, true);

  // WAV PCM is little-endian; every platform we run on is little-endian, so a
  // direct typed-array copy (vastly faster than per-sample DataView writes) is
  // correct here — the standard approach for in-browser WAV encoders.
  const out = new Int16Array(buf, 44, samples);
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }

  return new Blob([buf], { type: "audio/wav" });
}
