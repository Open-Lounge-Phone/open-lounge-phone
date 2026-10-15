#include "agc.h"

#include <math.h>

#define FLOOR_LEARN_MS 1000   // the first second of a call: the floor is the quietest frame
#define FLOOR_RISE_DB_S 0.5f  // then it may rise this fast (steady noise), and drops at once
#define ATTACK_MS 50.0f       // the speech level rises this fast (loud: less gain, quickly)…
#define RELEASE_MS 2000.0f    // …and falls this slowly (quiet: more gain, gently)
#define LIMIT_RELEASE_MS 50.0f

static float frame_db(const int16_t *pcm, size_t n) {
  if (!n) return -100;
  double sum = 0;
  for (size_t i = 0; i < n; i++) sum += (double)pcm[i] * pcm[i];
  double rms = sqrt(sum / (double)n) / 32768.0;
  return rms <= 1e-5 ? -100.0f : (float)(20 * log10(rms));
}

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

void agc_init(agc_t *a, int rate) {
  *a = (agc_t){.rate = rate, .gain_db = 0, .floor_db = -100, .limit = 1, .in_db = -100,
               .out_db = -100};
  a->limit_release = 1.0f - expf(-1.0f / (LIMIT_RELEASE_MS * 0.001f * (float)rate));
}

void agc_process(agc_t *a, int16_t *pcm, size_t n) {
  if (!n) return;
  float ms = 1000.0f * (float)n / (float)a->rate;
  float level = frame_db(pcm, n);
  a->in_db = level;

  // The noise floor: the quietest frame in the first second, then it follows steady noise up
  // slowly and quieter frames down at once.
  bool learning = a->frames * ms < FLOOR_LEARN_MS;
  if (a->frames == 0 || level < a->floor_db) a->floor_db = level;
  else if (!learning) a->floor_db += FLOOR_RISE_DB_S * ms / 1000.0f;
  if (a->floor_db > level) a->floor_db = level;
  a->frames++;

  // Speech: clearly above the floor (and not a dead line). Only speech moves the gain.
  float gate = a->floor_db + AGC_GATE_DB;
  a->speech = level > gate && level > AGC_SILENCE_DBFS;
  float from = a->gain_db;
  if (a->speech) {
    if (!a->have_speech) {
      a->speech_db = level;
      a->have_speech = true;
    } else {
      float tau = level > a->speech_db ? ATTACK_MS : RELEASE_MS;
      a->speech_db += (level - a->speech_db) * (1.0f - expf(-ms / tau));
    }
    a->gain_db = clampf(AGC_TARGET_DBFS - a->speech_db, AGC_MIN_GAIN_DB, AGC_MAX_GAIN_DB);
  }

  // Apply, ramping from the last frame's gain to this one's (no steps), then the peak limiter.
  float g0 = powf(10.0f, from / 20.0f), g1 = powf(10.0f, a->gain_db / 20.0f);
  const float limit = 32768.0f * powf(10.0f, AGC_LIMIT_DBFS / 20.0f);
  double sum = 0;
  for (size_t i = 0; i < n; i++) {
    float g = g0 + (g1 - g0) * (float)(i + 1) / (float)n;
    float y = (float)pcm[i] * g;
    float ay = fabsf(y) * a->limit;
    if (ay > limit) a->limit = limit / fabsf(y);  // instant attack: never above the limit
    else a->limit += (1.0f - a->limit) * a->limit_release;
    y *= a->limit;
    if (y > limit) y = limit;
    if (y < -limit) y = -limit;
    pcm[i] = (int16_t)lrintf(y);
    sum += (double)pcm[i] * pcm[i];
  }
  double rms = sqrt(sum / (double)n) / 32768.0;
  a->out_db = rms <= 1e-5 ? -100.0f : (float)(20 * log10(rms));
}

const char *agc_verdict(float speech_in_dbfs, float peak_dbfs) {
  if (peak_dbfs >= -1.0f) return "TOO LOUD";
  if (speech_in_dbfs < AGC_TARGET_DBFS - AGC_MAX_GAIN_DB - 3.0f) return "WEAK";
  return "OK";
}
