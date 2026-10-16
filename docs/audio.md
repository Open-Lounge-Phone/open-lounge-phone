# Call audio on the phone (firmware 0.9.6)

> **Status: built in firmware 0.9.6, tested in host tests and the QEMU simulator.** What only a
> real board can check is listed at the end: those items are untested.

The phone sends and receives **Opus at 16 kHz** (wideband), with **G.711 μ-law (PCMU) at 8 kHz**
as the fallback, 20 ms frames, through the ES8311 codec. The app and the browser phone use Opus
too. Each item below says what it does, how, how it's tested, and what can only be tuned on a
real board. The code is in `firmware/main/` (file names in brackets).

## 1. The right mic level, every time

**Problem.** On the first board, speech peaked around −38 dBFS at the PGA's 18 dB. That's about
25 dB too quiet. Handsets also differ: electret sensitivity varies by ±4 dB or more, and
people hold handsets differently.

**Design.**
- **A fixed analog gain** high enough for a quiet handset without clipping a loud one: the PGA
  at its top, 30 dB, plus 6 dB of the ADC's digital scale-up (`CONFIG_OLP_MIC_PGA_DB`,
  `CONFIG_OLP_MIC_SCALE_DB`). It is confirmed on a board with `audio gain` while a call or the
  phone check runs (BRINGUP.md).
- **A slow digital automatic gain control (AGC)** after the ADC (`agc.c`). It aims for −24 dBFS
  speech level, with a gain range of −6…+18 dB, 50 ms attack and 2 s release.
  - It only follows sound that looks like speech: frames 10 dB above the noise floor, which it
    takes from the quietest frame of the first second and then follows. Silences keep the
    gain they had, so the room's hiss isn't pumped up. A line with nothing on it gets no gain.
  - A peak limiter at −3 dBFS stops loud bursts from clipping.
  - `audio agc on|off` (on by default: `CONFIG_OLP_MIC_AGC`).
- **The phone check (MENU 7)** shows the live speech level with the handset up:
  `SPEAK NOW: -26 DB OK`. The number is after the AGC; the word is from the level at the ADC:
  `OK`, `WEAK` (quieter than the AGC can lift to −24 dBFS: a weak handset) or `TOO LOUD` (the
  ADC clips: too much analog gain). Before any speech it says `SPEAK NOW`.

**Tests.** Host tests (`test_agc.c`) feed speech-like bursts over −65 dBFS hiss: from −42 to
−18 dBFS the output settles at −24 ± 3 dB; quieter or louder input gets the +18 or −6 dB limit;
nothing ever goes above −3 dBFS, even a sudden loud burst after quiet speech; noise alone never
raises the gain, and pauses keep the gain they had; loud speech brings the gain down within
0.2 s, quiet speech brings it back up over seconds.

## 2. Wideband audio (Opus, 16 kHz)

**Problem.** 8 kHz audio cuts everything above 3.4 kHz. That's the "telephone" sound, and it
makes s/f/th hard to tell apart.

**Design.**
- **Opus for calls** (`voice.c`): mono, encoded and decoded at **16 kHz**, about 24 kbit/s,
  20 ms frames, complexity 5, voice mode, in-band error correction (FEC) on (with a 10 %
  expected loss, so the encoder actually adds it). RTP clock 48 kHz, as WebRTC requires. The
  library is the libopus inside Espressif's `espressif/esp_audio_codec`, used through libopus's
  own API (`opus_api.h`).
- **Negotiation** (`media.c`, `sdp.c`): the phone's SDP lists Opus and PCMU, and asks the other
  side for FEC and at most 16 kHz (`useinbandfec=1;maxplaybackrate=16000`). `esp_peer` sends the
  codec it was opened with, so:
  - answering, the phone sends Opus when the offer has it; an offer without Opus opens the peer
    again sending PCMU, before the answer goes out;
  - placing a call, the phone offers both and sends Opus. If the answer has no Opus (the log
    says so), the other side can't decode what the phone sends. Every browser and the add-on
    bridge answer with Opus; a phone on firmware 0.9.5 or older would answer PCMU only.
  - The log's `CODEC send=… recv=…` line says what a call uses. `CONFIG_OLP_CALL_OPUS=n`
    builds a PCMU-only phone.
- **The audio path runs at 16 kHz:** the ES8311 and I2S at 16 kHz (MCLK = 256 × fs = 4.096 MHz;
  the codec's clock registers are the same as at 8 kHz), and the frame is 320 samples.
  Call-progress tones and the tone meters run at 16 kHz.
- **PCMU calls, the house intercom, voicemail and greetings stay 8 kHz** (WAV everywhere, at
  8 kHz: apps and the server assume it). They go through 2:1 half-band resamplers
  (`resample.c`, 63 taps, Kaiser β 7): flat to 3.4 kHz within 0.01 dB, at least 70 dB down from
  4.6 kHz, about 2 ms each way.
- **Budget** (measured on the board by the code; the `AUDIO` line every 5 s in a call shows
  `enc=` and `dec=` per 20 ms frame, average/worst in µs, and the audio task's free stack).
  - libopus encodes on the audio task's stack, which is 36 KB (it uses about 26 KB). The Opus
    states (about 40 KB) are in PSRAM, so internal RAM stays for the call's network.
  - Flash: Opus adds about 175 KB and the echo canceller (item 5) about 35 KB. The images are
    1.59 MB (rev A) and 1.63 MB (hw v0.901), with 373 KB and 340 KB of the 1.875 MB app
    partition free: the partition table stays as it is.

**Tests.**
- **Host:** the resamplers (down: a sweep 100 Hz to 7.9 kHz, flat to 3.4 kHz and at least 60 dB
  down from 4.6 kHz; up: flat, images at least 60 dB down; frame by frame equals one block);
  the Opus wrapper (`test_voice.c`, against the system's libopus) encoding then decoding tones
  from 200 Hz to 7 kHz, each within 3 dB, at about 24 kbit/s; PCMU passing 1 kHz and stopping
  6 kHz; the SDP helpers.
- **QEMU end-to-end** (`tests/e2e/live/codec.test.ts`, entirely local: the firmware in QEMU,
  a self-hosted server and the companion in Chromium):
  - a call from the companion negotiates Opus both ways, and the phone and the companion each
    hear the other's 5–6 kHz test tone (only wideband carries it);
  - with Opus taken out of the companion's offer, both sides use PCMU and those tones are gone;
  - a call the phone places offers Opus and PCMU and the answer picks Opus. Its media doesn't
    connect in QEMU: behind QEMU's NAT, without TURN, `esp_peer` as the controlling side won't
    nominate the pair the browser's checks map to (the live firmware test covers it over TURN).
- **On the board:** a listening test against the old build.

## 3. Sidetone

**Problem.** On a real phone you hear yourself faintly in the earpiece. Without it, the line
feels dead and people talk louder.

**Design.**
- **About −20 dB of your own voice in the earpiece,** only while a call is connected, never
  while muted or on hold.
- **Latency must stay under about 5 ms,** or it sounds like an echo.
  - The ES8311's ADC→DAC path can't do it: its register 0x44 bit 7 (`ADC2DAC_SEL`) selects the
    DAC's source, the ADC *instead of* the I2S input, so it would replace the other side's
    voice rather than mix with it.
  - So it's a software mix in the I2S pump (`audio.c`): a task that reads and writes the codec
    in **1 ms DMA blocks** (`CONFIG_OLP_AUDIO_BLOCK`, three DMA buffers) and adds the mic block
    it just read to the block it writes. By design that's about 4 ms mic to ear: a block in,
    two queued out, about 1 ms in the codec's filters. The 20 ms work (codecs, AGC, echo
    canceller, tones, voicemail) is the audio task's, through lock-free FIFOs (`fifo.c`), with
    about 15 ms queued for the earpiece.
  - The echo test (item 5) measures the earpiece-to-mic delay, which is the same path. If it's
    over 5 ms, the sidetone stays off (`audio` shows `sidetone=off(slow)`).
- **Level:** a per-phone setting (MENU 1 Volume → 6: `6 SIDETONE OFF / LOW / NORMAL`), default
  normal (−20 dB; low is −26 dB). `audio sidetone off|low|normal`.

**Tests.** Host tests for the mixer's gain (−20 and −26 dB within 0.2 dB), off (nothing added),
mixing and saturation, the FIFO, and the menu item. The latency and the level are checked on
the board.

## 4. Smoothing over lost audio (concealment)

**Problem.** A late or lost packet gives a click or a gap.

**Design.**
- **Jitter buffer** (`jbuf.c`): packets go in by timestamp, in any order. Playout starts at
  60 ms, then the target adapts between 40 and 120 ms to the measured jitter (RFC 3550's
  estimator: 30 ms + 3 × jitter). An empty buffer is concealed without moving on, so a late
  packet still plays and the delay grows instead; after 100 ms of nothing it buffers up again.
  Too much buffered for 200 ms (a burst, or the sender's clock running fast) drops a frame. A
  gap after a 1–2 byte Opus frame is the sender's DTX, not a loss.
- **Opus:** a missing packet is recovered from the next packet's FEC when it's there, else the
  decoder conceals it.
- **PCMU:** G.711 Appendix I-style concealment (`plc.c`): it finds the pitch (5–15 ms) by
  autocorrelation, blends the last quarter period into the one before it, and repeats it; after
  10 ms it fades out, reaching silence at 60 ms; when audio returns it cross-fades back. The
  output runs 3.75 ms behind to make that blend possible.
- The `AUDIO` log line reports `conceal=` (lost or missing frames: the poor-connection signal),
  `fec=` (recovered by FEC), `late=`, the buffer's target `jb=` and the jitter `jit=`.

**Tests.** Host tests: a voice with every 4th to 7th frame dropped has no step at the frame
edges larger than 1.5 × the clean signal's; the first 10 ms made up for a steady voice follow it
(at least 12 dB signal to error: the right period); long losses fade to silence by 60 ms and
come back without a step; the jitter buffer keeps order through reordering, reports a loss with
the next packet for FEC, adapts its target to jitter, stretches on an underrun without losing
late packets, stays bounded with a fast sender, and treats a DTX gap as quiet. Opus FEC recovers
lost frames much better than concealment alone (and it is the lost frame, not the next one).

## 5. Echo removal

**Problem.** The far side can hear themselves if the earpiece's sound reaches the handset mic:
handset acoustics, a loud earpiece volume, or sidetone set too high. Good handsets keep this
low, but cheap ones don't.

**Design** (`echo.c`).
- **Measure first.**
  - Every call measures the echo return loss (ERL): what the earpiece played against the mic,
    over the moments the other side is talking, in one-second windows. The `AUDIO` line shows
    the last window (`erl=`) and the call's best (`erlbest=`, the window least disturbed by the
    phone's own user talking).
  - The phone check's **echo test** (MENU 7 → 2, handset up and held normally): 0.3 s of quiet
    (the mic's noise), a 1.5 s sweep from 200 Hz to 7 kHz at −20 dBFS, then 0.2 s more. It finds
    the delay by cross-correlation (0–50 ms) and the loss from what came back above the noise.
    The page shows `38 DB OK, 4 MS` (`GOOD` from 45 dB, `OK` from 30 dB, else `POOR`), or
    `OVER 52 DB GOOD` when nothing came back above the noise. Over 5 ms turns the sidetone off;
    a poor loss turns the echo canceller on for this phone. The log line is `ECHOTEST …`.
- **The echo canceller** is SpeexDSP 1.2.1's (`firmware/components/speexdsp`, BSD-3-Clause,
  unmodified): a frequency-domain adaptive filter (multidelay block NLMS) with a **64 ms tail**,
  in 10 ms blocks, plus its residual echo suppressor (which works through the preprocessor's
  spectral gain, with its noise suppression set to a mild 6 dB). It runs before the AGC, where
  the echo path is linear. Its states are in PSRAM. It is open source, small (about 35 KB of
  flash) and runs in the host tests, unlike Espressif's `esp-sr` AEC. The `AUDIO` line
  shows its time per frame (`aec=`), the echo it removed (`erle=`) and how often it reset
  itself after diverging (`aecreset=`).
- **Reference signal:** exactly what the earpiece played, beside each mic block in the pump,
  scaled by the earpiece volume. The sidetone isn't in it: that is the phone user's own voice,
  and cancelling it would cancel them.
- **Settings:** off by default (`CONFIG_OLP_ECHO_CANCEL=n`) until the reference handsets are
  measured; on by default only if their ERL is poor. Per phone: MENU 1 → 7
  (`7 ECHO CANCEL ON / OFF`, from the next call), `audio echo on|off|test`, and an echo test that
  finds a poor loss turns it on.

**Tests.** Host tests (`test_echo.c`): a synthetic handset echo path (a leak 3 ms after the
earpiece and weaker reflections over 20 ms, about 20 dB of loss) with speech-like far-end
audio: the canceller removes at least 20 dB of echo from 1 s on; during double talk the near
end's voice comes through (within 6 dB), and right after it the echo is gone again (at least
15 dB); the ERL meter reads the path's loss within 1.5 dB and leaves the mic alone when the
canceller is off; the echo test finds a 35 dB loss within 2 dB and a 4 ms delay within 0.2 ms,
and reports a quiet line as good. In QEMU the echo test runs and finds no echo (the test device
has none), and a call runs with the canceller on. The real check is on the board with the
reference handsets.

## Server and protocol

Nothing changes there: Opus is negotiated in the SDP, which the server only relays.

**Only on a real board** (untested until the owner flashes one):
- the analog gain default (PGA 30 dB + 6 dB scale-up) with each handset: `SPEAK NOW: … OK`, no
  `TOO LOUD` when shouting, no `WEAK` at a normal voice;
- the ES8311 at 16 kHz and the 1 ms DMA blocks: clean audio both ways, `dry=0` in the `AUDIO`
  line (the earpiece never ran dry);
- the sidetone: its delay (the echo test's `MS`, under 5) and whether −20 / −26 dB sound right;
- Opus: a listening test against 0.9.5, and the `enc=` / `dec=` / `aec=` CPU times per frame;
- the echo test and in-call `erl=` with each reference handset, then whether the canceller
  should be on by default.
