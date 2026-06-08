# @sdr/server

Bun backend: manages `rtl_tcp`, runs the DSP, and serves a WebSocket.

## Data flow

```
rtl_tcp (child) ──TCP──► RtlTcpClient ──IQ float──► Radio (session.ts)
                                                       ├─ SpectrumAnalyzer ─► FFT frames (20 fps)
                                                       └─ Nco(VFO) ─► Demodulator ─► audio PCM
                                                                                       │
                                                            Bun.serve WebSocket  ◄─────┘
                                                            publish("radio", ...) to all clients
```

- **rtltcp/** — `manager.ts` spawns/supervises `rtl_tcp`; `client.ts` parses the
  `RTL0` header and streams normalized IQ; `commands.ts` encodes the 5-byte
  control packets (`[cmd:u8][param:u32be]`), including `SET_DIRECT_SAMPLING`
  (`0x09`) and `SET_BIAS_TEE` (`0x0e`).
- **dsp/** — `fft.ts` (windowed FFT spectrum), `nco.ts` (complex frequency
  shift for the VFO), `filters.ts` (windowed-sinc FIR + complex decimator),
  `demod.ts` (WFM/NFM via discriminator, AM envelope, SSB via the Weaver method,
  CW as narrow SSB), `resample.ts` (fractional resample to 48 kHz).
- **session.ts** — wires it together; one shared `Radio` per process.
- **index.ts** — `Bun.serve` HTTP + WebSocket; the dongle starts on the first
  client and stops when the last leaves.

## Run

```sh
bun run dev        # watch mode, port 8787 (override with PORT=)
bun run test:dsp   # synthetic-signal self-test for the demodulators
```

`rtl_tcp` must be on PATH (`brew install librtlsdr`).

## Notes

- IQ is 8-bit unsigned, normalized to `(b - 127.5) / 127.5`.
- Tuning within the captured band uses the VFO NCO (no dongle retune); tuning
  outside it changes the dongle center frequency.
- CW is demodulated as narrow USB — zero-beat the carrier by tuning for the tone.
- The first decimation FIR runs at full sample rate; if CPU-bound at 2.4 MSPS,
  move it to a WASM FFT or a Bun worker (the WS protocol/UI are unaffected).
