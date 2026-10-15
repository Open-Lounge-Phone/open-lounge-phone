# Call audio on the phone (design for firmware 0.9.5)

> **Status: planned.** Firmware 0.9.4 fixes the mic being read twice per sample (calls and
> voicemail sounded like mush) and stops Wi-Fi power saving. This page is the design for the next
> five improvements. None of them is built yet.

Today the phone sends and receives **G.711 μ-law (PCMU) at 8 kHz**, 20 ms frames, through the
ES8311 codec: classic telephone audio. The app and the browser phone use Opus. Each item below
says what it does, how, how it's tested, and what can only be tuned on a real board.

## 1. The right mic level, every time

**Problem.** On the first board, speech peaked around −38 dBFS at the PGA's 18 dB. That's about
25 dB too quiet. Handsets also differ: electret sensitivity varies by ±4 dB or more, and
people hold handsets differently.

**Design.**
- **A fixed analog gain** set high enough for a quiet handset without clipping a loud one. It
  comes from a measurement on the board: `audio gain` (built) while `audio loop` or a call runs,
  reading `miclevel`. The value goes into Kconfig as the new default.
- **A slow digital automatic gain control (AGC)** after the ADC. It aims for −24 dBFS speech
  level, with a gain range of −6…+18 dB, about 50 ms attack and about 2 s release.
  - It only follows sound that looks like speech: a level gate above the noise floor,
    measured in the first second of a call. So it doesn't pump up the room hiss in silences.
  - A peak limiter at −3 dBFS stops loud bursts from clipping.
- **The phone check (MENU 7)** shows the live level ("SPEAK NOW: −26 dB OK"), so anyone can tell
  a weak handset from a broken one.

**Tests.** Host tests feed synthetic speech-like bursts at −50…−10 dBFS and check the output
settles at −24 ± 3 dB, never clips, and doesn't raise silence above the gate.

## 2. Wideband audio (Opus, 16 kHz)

**Problem.** 8 kHz audio cuts everything above 3.4 kHz. That's the "telephone" sound, and it
makes s/f/th hard to tell apart.

**Design.**
- **Opus for calls.** The phone offers and accepts **Opus** (RTP clock 48 kHz, as WebRTC
  requires), encoding and decoding mono **16 kHz wideband**, at about 24 kbit/s, 20 ms frames,
  with in-band error correction (FEC) on.
  - It uses Espressif's Opus codec for the ESP32-S3 (`espressif/esp_audio_codec`).
  - `esp_peer` already negotiates `ESP_PEER_AUDIO_CODEC_OPUS`; today it's PCMU only.
- **Fallback:** PCMU stays as a fallback in the offer/answer for any peer that can't do Opus.
  Every browser and the add-on bridge can.
- **The audio path runs at 16 kHz:** the ES8311 and I2S at 16 kHz (MCLK = 256 × fs), and the
  DSP frame becomes 320 samples. Call-progress tones and the tone detector move to 16 kHz.
- **Voicemail and greetings stay 8 kHz WAV** (the owner chose "WAV everywhere" at 8 kHz;
  apps and the server assume it). The phone downsamples with a proper low-pass filter for
  recording and upsamples for playback. A later change can move voicemail to 16 kHz in one
  coordinated step.
- **Budget.**
  - Opus encode + decode at complexity 5 on one 240 MHz core is well within budget for
    16 kHz mono. The code measures it and logs the CPU time per frame.
  - The codec library adds about 200–300 KB of flash; the app partition has about 600 KB free.
  - If this item plus item 5 doesn't fit, the image header and partition table move to the
    module's real 16 MB flash. That needs one USB re-flash, not an over-the-air update. It
    would be announced in the changelog.

**Tests.**
- **Host:** the resamplers (frequency response: passband flat to 7 kHz at 16 kHz, stopband
  below −60 dB) and the Opus wrapper encoding then decoding a sweep.
- **QEMU end-to-end:** a call from the companion to the phone negotiates Opus, and PCMU when
  Opus is removed from the offer.
- **On the board:** a listening test against the old build.

## 3. Sidetone

**Problem.** On a real phone you hear yourself faintly in the earpiece. Without it, the line
feels dead and people talk louder.

**Design.**
- **Mix about −20 dB of your own voice into the earpiece,** only while a call is connected and
  not muted.
- **Latency must stay under about 5 ms,** or it sounds like an echo. A software mix after a 20 ms
  frame is too slow, so:
  1. **First choice:** the ES8311's own ADC→DAC digital path, with no extra latency. To be
     confirmed on the board from the datasheet registers, with a console command
     `audio sidetone <dB|off>` to try it.
  2. **Fallback:** a software mix in the I2S task using 2.5 ms sub-frames. It's measured on the
     board, and if its latency is above 5 ms the feature stays off.
- **Level:** a per-phone setting (MENU 1 Volume → Sidetone: off / low / normal), default
  normal. It turns off while muted, so mute is unmistakable.

**Tests.** Host tests for the software mixer's gain and mute behaviour. The latency and the
codec path are checked on the board.

## 4. Smoothing over lost audio (concealment)

**Problem.** A late or lost packet gives a click or a gap.

**Design.**
- **Opus:** the decoder conceals by itself. On a missing packet the phone asks it to fill the
  gap, and FEC recovers single losses from the next packet.
- **PCMU (fallback):** G.711 Appendix I-style concealment. It repeats the last pitch period with
  a 10 ms fade-out over consecutive losses, then silence, and cross-fades back when audio
  returns.
- **Jitter buffer:** the playout start target stays at 60 ms but adapts between 40 and 120 ms to
  the measured jitter. The `AUDIO` log line reports concealed frames, so the poor-connection
  notice (0.9.4) can use it.

**Tests.** Host tests: a sine with every Nth frame dropped. No discontinuity above a threshold
at the frame edges, and energy fades out over long losses.

## 5. Echo removal

**Problem.** The far side can hear themselves if the earpiece's sound reaches the handset mic:
handset acoustics, a loud earpiece volume, or sidetone set too high. Good handsets keep this
low, but cheap ones don't.

**Design.**
- **Measure first.** The phone check gains an echo test: it plays a short sweep in the earpiece
  with the handset held normally and measures how much returns in the mic (echo return loss,
  ERL). The build also logs ERL during calls, from the far-end signal and the mic.
- **A small echo canceller.** It uses Espressif's acoustic echo canceller (from `esp-sr`, which
  runs on the S3) if it fits the flash and CPU budget next to Opus. Otherwise a lighter
  adaptive filter: NLMS, a 64 ms tail at 16 kHz, plus a residual echo suppressor.
- **Reference signal:** exactly what's played to the earpiece, taken after volume.
- **Settings:** on by default only if the measured ERL on the reference handsets is poor; a
  per-phone setting otherwise, so a good handset doesn't pay the small loss of naturalness.

**Tests.** Host tests: a synthetic room/handset impulse response (echo path) and far-end
speech; the canceller must remove at least 20 dB of echo after convergence (under 1 s) without
cancelling near-end speech during double-talk. The real check is on the board with the
reference handsets.

## Order and release

All five ship together as firmware **0.9.5**, in this order inside the build: AGC (1),
concealment (4), Opus (2), sidetone (3), echo (5). Each step keeps the call working if the next
one isn't ready. No server or protocol change is needed: Opus is negotiated in the SDP, which the
server only relays.

**Only on a real board** (the owner, after flashing): the analog gain default, the sidetone path
and level, the Opus listening test, and the echo measurement with each handset.
