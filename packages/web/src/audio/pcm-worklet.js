// AudioWorklet processor: a ring buffer that plays queued Float32 PCM chunks,
// absorbing WebSocket jitter. Drops the oldest audio if latency grows too large,
// and outputs silence on underflow.

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.readOffset = 0;
    this.buffered = 0;
    this.maxBuffered = sampleRate * 0.4; // cap ~400 ms of latency
    this.port.onmessage = (e) => {
      const data = e.data;
      if (data === "flush") {
        this.queue = [];
        this.readOffset = 0;
        this.buffered = 0;
        return;
      }
      this.queue.push(data);
      this.buffered += data.length;
      while (this.buffered > this.maxBuffered && this.queue.length > 1) {
        const c = this.queue.shift();
        this.buffered -= c.length - this.readOffset;
        this.readOffset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      if (this.queue.length === 0) {
        channel[i] = 0;
        continue;
      }
      const cur = this.queue[0];
      channel[i] = cur[this.readOffset++];
      this.buffered--;
      if (this.readOffset >= cur.length) {
        this.queue.shift();
        this.readOffset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);
