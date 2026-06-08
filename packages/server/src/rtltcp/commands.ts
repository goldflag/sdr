// rtl_tcp control command codes. Each command is a 5-byte packet:
//   [cmd: u8][param: u32 big-endian]
// Reference: librtlsdr / rtl-sdr-blog src/rtl_tcp.c
export enum RtlTcpCmd {
  SET_FREQUENCY = 0x01, // Hz
  SET_SAMPLE_RATE = 0x02, // Hz
  SET_TUNER_GAIN_MODE = 0x03, // 0 = auto (tuner AGC), 1 = manual
  SET_GAIN = 0x04, // tenths of a dB
  SET_FREQ_CORRECTION = 0x05, // ppm
  SET_IF_GAIN = 0x06, // (stage << 16) | gain
  SET_TEST_MODE = 0x07,
  SET_AGC_MODE = 0x08, // RTL2832 digital AGC: 0/1
  SET_DIRECT_SAMPLING = 0x09, // 0 off, 1 I-branch, 2 Q-branch
  SET_OFFSET_TUNING = 0x0a,
  SET_RTL_XTAL = 0x0b,
  SET_TUNER_XTAL = 0x0c,
  SET_TUNER_GAIN_BY_INDEX = 0x0d,
  SET_BIAS_TEE = 0x0e, // 0/1 (RTL-SDR V3 4.5V bias tee)
}

/** Encodes a 5-byte rtl_tcp command packet. */
export function encodeCommand(cmd: RtlTcpCmd, param: number): Uint8Array {
  const buf = new Uint8Array(5);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, cmd);
  // Param is unsigned 32-bit, network byte order (big-endian).
  dv.setUint32(1, param >>> 0, false);
  return buf;
}
