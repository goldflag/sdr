# sdr — web SDR client for RTL-SDR Blog V3

Fullstack TypeScript web SDR receiver. Bun backend manages `rtl_tcp` and does the
DSP (FFT spectrum + demodulation); React/Tailwind/shadcn frontend renders the
spectrum/waterfall and plays demodulated audio.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- `librtlsdr` (provides `rtl_tcp`): `brew install librtlsdr`
- An RTL-SDR Blog V3 dongle plugged in (`rtl_test -t` should list it)

Optional (features disable themselves when missing):

- `rtl_433` for ISM-band sensor decode: `brew install rtl_433`
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) for live speech-to-text
  of the tuned station: `brew install whisper-cpp`, then download a ggml model
  into `~/.cache/whisper.cpp` (or `models/`), e.g.

  ```sh
  curl -L -o ~/.cache/whisper.cpp/ggml-small.en.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin
  ```

  Pick between downloaded models in the transcript panel (the largest is the
  default; `WHISPER_MODEL=/path/to.bin` overrides, `WHISPER_LANG=auto` for
  non-English stations). Dropping a Silero VAD model
  (`ggml-silero-*.bin`) alongside it makes whisper skip music instead of
  hallucinating lyrics over it.

## Run

```sh
bun install
bun run dev        # starts server (:8787) and web (:5173) together
```

Open http://localhost:5173.

## Layout

- `packages/shared` — WS protocol types, modes, constants, rtl_tcp command codes
- `packages/server` — Bun: rtl_tcp manager + TCP client, DSP pipeline, WebSocket server
- `packages/web`    — Vite + React + Tailwind + shadcn UI

See `packages/server/README.md` for the DSP pipeline and the rtl_tcp protocol notes.
