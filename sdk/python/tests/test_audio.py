import asyncio
import math
import struct
import unittest

from olp_addon.audio import TRACK_RATE, Chunker, PcmTrack, Resampler, frame_bytes


def sine(hz: float, rate: int, seconds: float, amp: int = 12000) -> bytes:
    n = int(rate * seconds)
    return struct.pack(f"<{n}h", *(int(amp * math.sin(2 * math.pi * hz * i / rate)) for i in range(n)))


def samples(pcm: bytes) -> list[int]:
    return list(struct.unpack(f"<{len(pcm) // 2}h", pcm[: len(pcm) // 2 * 2]))


def crossings(pcm: bytes) -> int:
    s = samples(pcm)
    return sum(1 for a, b in zip(s, s[1:]) if (a < 0) != (b < 0))


class ResampleTest(unittest.TestCase):
    def stream(self, r: Resampler, pcm: bytes, rate: int) -> bytes:
        step = frame_bytes(rate)
        return b"".join(r.pcm(pcm[i : i + step]) for i in range(0, len(pcm), step))

    def test_down_and_up_keep_length_and_pitch(self) -> None:
        for src, dst in [(48_000, 16_000), (16_000, 48_000), (8_000, 48_000), (48_000, 8_000)]:
            with self.subTest(src=src, dst=dst):
                pcm = sine(440, src, 1.0)
                out = self.stream(Resampler(dst, src_rate=src), pcm, src)
                # About one second at the new rate (a filter holds back a few ms).
                self.assertAlmostEqual(len(out) / 2 / dst, 1.0, delta=0.02)
                # A 440 Hz tone crosses zero about 880 times a second, at any rate.
                self.assertAlmostEqual(crossings(out), 880, delta=15)

    def test_same_rate_passes_through(self) -> None:
        pcm = sine(1000, 48_000, 0.02)
        self.assertEqual(Resampler(48_000, src_rate=48_000).pcm(pcm), pcm)

    def test_frames_are_20_ms(self) -> None:
        self.assertEqual(frame_bytes(48_000), 1920)
        self.assertEqual(frame_bytes(16_000), 640)
        self.assertEqual(frame_bytes(8_000), 320)
        c = Chunker(4)
        self.assertEqual(c.push(b"abcdefghij"), [b"abcd", b"efgh"])
        self.assertEqual(c.push(b"kl"), [b"ijkl"])
        self.assertEqual(c.push(b""), [])


class TrackTest(unittest.IsolatedAsyncioTestCase):
    async def test_plays_what_it_was_given_then_silence(self) -> None:
        track = PcmTrack()
        tone = sine(1000, TRACK_RATE, 0.04)
        track.push(tone)
        first = await track.recv()
        second = await track.recv()
        third = await track.recv()
        for f in (first, second, third):
            self.assertEqual(f.samples, 960)
            self.assertEqual(f.sample_rate, TRACK_RATE)
        played = bytes(first.planes[0])[:1920] + bytes(second.planes[0])[:1920]
        self.assertEqual(played, tone)
        self.assertEqual(set(bytes(third.planes[0])[:1920]), {0})
        self.assertEqual(third.pts - second.pts, 960)
        track.stop()

    async def test_holds_a_fast_sender_back(self) -> None:
        track = PcmTrack()
        track.push(b"\0" * frame_bytes(TRACK_RATE, 1200))
        with self.assertRaises(asyncio.TimeoutError):
            await asyncio.wait_for(track.wait_room(), 0.05)
        track.clear()
        await asyncio.wait_for(track.wait_room(), 0.05)
        track.stop()


if __name__ == "__main__":
    unittest.main()
