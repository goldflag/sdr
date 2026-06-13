// Runtime validation of incoming ClientMessages. The server cannot trust the
// JSON a socket hands it — a stale client, a curious LAN neighbour, or a plain
// bug could otherwise inject NaN/Infinity into RadioState (poisoning every FFT
// frame) or hand the scanner a malformed config. parseClientMessage returns a
// well-typed message or null; the server drops nulls.
//
// Lives behind the "@sdr/shared/validate" subpath rather than the package
// index so zod stays out of the browser bundle — only the server imports it.

import { z } from "zod";
import {
  type ClientMessage,
  AGC_MODES,
  DIRECT_SAMPLING,
  MODES,
} from "./protocol";

/** Matches the scanner's own MAX_ENTRIES safety cap. */
const MAX_SCAN_ENTRIES = 5000;
const MAX_NOTCHES = 8;

// zod 4's z.number() rejects NaN and ±Infinity by default.
const finite = z.number();
const mode = z.enum(MODES);
const directSampling = z.union([
  z.literal(DIRECT_SAMPLING.OFF),
  z.literal(DIRECT_SAMPLING.I_BRANCH),
  z.literal(DIRECT_SAMPLING.Q_BRANCH),
]);

/** `{ type: T }` */
const bare = <T extends string>(type: T) => z.object({ type: z.literal(type) });
/** `{ type: T; hz: number }` */
const hzMsg = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), hz: finite });
/** `{ type: T; on: boolean }` */
const onMsg = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), on: z.boolean() });

const scanCommon = {
  thresholdDb: finite,
  dwellMs: finite,
  resumeMs: finite,
};

const scanEntry = z.object({
  hz: finite,
  mode,
  bandwidth: finite.positive().optional(),
  directSampling: directSampling.optional(),
  label: z.string().optional(),
});

const scanConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("channels"),
    entries: z.array(scanEntry).max(MAX_SCAN_ENTRIES),
    ...scanCommon,
  }),
  z.object({
    kind: z.literal("range"),
    startHz: finite,
    stopHz: finite,
    stepHz: finite.positive(),
    mode,
    directSampling: directSampling.optional(),
    ...scanCommon,
  }),
]);

// `satisfies` keeps the schema in lock-step with the hand-written ClientMessage
// union in protocol.ts: a field-type drift here is a compile error.
export const ClientMessageSchema = z.discriminatedUnion("type", [
  bare("start"),
  bare("stop"),
  bare("scanStop"),
  bare("scanSkip"),
  hzMsg("setFrequency"),
  hzMsg("setSampleRate"),
  hzMsg("setBandwidth"),
  hzMsg("setVfoOffset"),
  hzMsg("setIsmFreq"),
  z.object({ type: z.literal("setMode"), mode }),
  z.object({ type: z.literal("setPassband"), low: finite, high: finite }),
  z.object({
    type: z.literal("setNr"),
    on: z.boolean(),
    level: finite.optional(),
  }),
  z.object({
    type: z.literal("setNb"),
    on: z.boolean(),
    threshold: finite.optional(),
  }),
  z.object({ type: z.literal("setAgc"), mode: z.enum(AGC_MODES) }),
  z.object({
    type: z.literal("setNotches"),
    notches: z.array(finite).max(MAX_NOTCHES),
  }),
  z.object({ type: z.literal("scanStart"), config: scanConfig }),
  z.object({
    type: z.literal("setGain"),
    mode: z.enum(["auto", "manual"]),
    db: finite.optional(),
  }),
  z.object({ type: z.literal("setSquelch"), db: finite.nullable() }),
  z.object({
    type: z.literal("setToneSquelch"),
    tone: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("ctcss"), hz: finite.positive() }),
        z.object({
          kind: z.literal("dcs"),
          code: z.number().int().min(0).max(0o777),
          inverted: z.boolean(),
        }),
      ])
      .nullable(),
  }),
  z.object({
    type: z.literal("setSpectrumAvg"),
    level: finite.min(0).max(1),
  }),
  z.object({
    type: z.literal("setSpectrumView"),
    view: z
      .object({ centerHz: finite, spanHz: finite.positive() })
      .nullable(),
  }),
  z.object({ type: z.literal("setPpm"), ppm: finite }),
  onMsg("setBiasTee"),
  z.object({ type: z.literal("setDirectSampling"), value: directSampling }),
  onMsg("setAdsb"),
  z.object({
    type: z.literal("setAdsbRef"),
    lat: finite.nullable(),
    lon: finite.nullable(),
  }),
  onMsg("setAis"),
  onMsg("setAprs"),
  onMsg("setIsm"),
  onMsg("setTranscribe"),
  z.object({
    type: z.literal("setTranscribeModel"),
    model: z.string().max(200),
  }),
]) satisfies z.ZodType<ClientMessage>;

/** Validate a parsed-JSON value as a ClientMessage; null if malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  const result = ClientMessageSchema.safeParse(raw);
  return result.success ? result.data : null;
}
