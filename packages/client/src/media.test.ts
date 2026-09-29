import { expect, it } from "vitest";
import { withOpusDtx } from "./media.ts";

const offer = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:9 G722/8000",
  "",
].join("\r\n");

it("turns on Opus DTX and leaves other codecs alone", () => {
  const out = withOpusDtx(offer);
  expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n");
  expect(out).toContain("a=fmtp:63 111/111\r\n");
  expect(out.split("\r\n")).toHaveLength(offer.split("\r\n").length);
  // Idempotent, and it flips an explicit usedtx=0.
  expect(withOpusDtx(out)).toBe(out);
  expect(withOpusDtx(offer.replace("useinbandfec=1", "usedtx=0"))).toContain(
    "a=fmtp:111 minptime=10;usedtx=1",
  );
});

it("adds an fmtp line when Opus has none", () => {
  const bare = "v=0\na=rtpmap:109 opus/48000/2\na=rtpmap:0 PCMU/8000\n";
  expect(withOpusDtx(bare)).toBe(
    "v=0\na=rtpmap:109 opus/48000/2\na=fmtp:109 usedtx=1\na=rtpmap:0 PCMU/8000\n",
  );
});
