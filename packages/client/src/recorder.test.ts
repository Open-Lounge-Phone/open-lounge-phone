import { describe, expect, it } from "vitest";
import { encodeWav, MESSAGE_RATE, resample } from "./recorder.ts";

describe("encodeWav", () => {
  it("writes a 16-bit PCM mono header and clipped samples", () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2]), MESSAGE_RATE);
    const v = new DataView(wav.buffer);
    const text = (at: number, n: number) => String.fromCharCode(...wav.subarray(at, at + n));
    expect(wav.length).toBe(44 + 8);
    expect(text(0, 4)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 8);
    expect(text(8, 8)).toBe("WAVEfmt ");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // mono
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(28, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe("data");
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767,
    ]);
  });

  it("keeps two minutes under the 2 MB upload limit", () => {
    expect(44 + 120 * MESSAGE_RATE * 2).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});

describe("resample", () => {
  it("averages down to 8 kHz", () => {
    const input = new Float32Array(48).map((_, i) => (i % 6 < 3 ? 1 : 0));
    const out = resample(input, 48_000, 8000);
    expect(out.length).toBe(8);
    for (const s of out) expect(s).toBeCloseTo(0.5);
  });

  it("removes a tone above the new Nyquist and keeps a low one", () => {
    const tone = (hz: number) =>
      new Float32Array(48_000).map((_, i) => Math.sin((2 * Math.PI * hz * i) / 48_000));
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((n, x) => n + x * x, 0) / a.length);
    expect(rms(resample(tone(400), 48_000, 8000))).toBeGreaterThan(0.65);
    expect(rms(resample(tone(8000), 48_000, 8000))).toBeLessThan(0.05);
  });

  it("copies when the rate already matches", () => {
    const a = new Float32Array([0.1, 0.2]);
    expect(Array.from(resample(a, 8000, 8000))).toEqual(Array.from(a));
  });
});
