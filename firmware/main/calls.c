#include "calls.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void last_dial_encode(const last_dial_t *d, char *out, size_t n) {
  switch (d->kind) {
    case DIAL_KEY: snprintf(out, n, "k:%d", d->index); break;
    case DIAL_EXT: snprintf(out, n, "e:%s", d->text); break;
    case DIAL_BACK: snprintf(out, n, "b:%s", d->text); break;
    default: snprintf(out, n, "%s", ""); break;
  }
}

bool last_dial_decode(const char *s, last_dial_t *d) {
  memset(d, 0, sizeof *d);
  d->kind = DIAL_NONE;
  if (!s || strlen(s) < 3 || s[1] != ':') return false;
  const char *v = s + 2;
  if (s[0] == 'k') {
    char *end;
    long i = strtol(v, &end, 10);
    if (*end || i < 0 || i > 99) return false;  // ten pages of ten keys
    d->kind = DIAL_KEY;
    d->index = (int)i;
    return true;
  }
  if (strlen(v) >= sizeof d->text) return false;
  if (s[0] == 'e') {
    size_t len = strlen(v);
    if (len < 2 || len > 6 || strspn(v, "0123456789") != len) return false;
    d->kind = DIAL_EXT;
  } else if (s[0] == 'b') {
    d->kind = DIAL_BACK;
  } else {
    return false;
  }
  snprintf(d->text, sizeof d->text, "%s", v);
  return true;
}

/** Days since 1970-01-01 → year, month (1-12), day (Howard Hinnant's civil_from_days). */
static void civil(int64_t z, int *y, int *m, int *d) {
  z += 719468;
  int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned doe = (unsigned)(z - era * 146097);
  unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  unsigned mp = (5 * doy + 2) / 153;
  *d = (int)(doy - (153 * mp + 2) / 5 + 1);
  *m = (int)(mp < 10 ? mp + 3 : mp - 9);
  *y = (int)(yoe + era * 400 + (*m <= 2));
}

static int64_t floor_div(int64_t a, int64_t b) { return a / b - (a % b != 0 && (a < 0) != (b < 0)); }

void missed_when(char *out, size_t n, int64_t at_ms, int64_t now_ms, int offset_min) {
  static const char *months[] = {"JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                                 "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"};
  const int64_t day_ms = 86400000;
  int64_t local = at_ms + (int64_t)offset_min * 60000;
  int64_t day = floor_div(local, day_ms), today = floor_div(now_ms + (int64_t)offset_min * 60000, day_ms);
  int64_t in_day = local - day * day_ms;
  int hh = (int)(in_day / 3600000), mm = (int)(in_day / 60000 % 60);
  if (day == today) {
    snprintf(out, n, "%02d:%02d", hh, mm);
  } else if (day == today - 1) {
    snprintf(out, n, "YESTERDAY %02d:%02d", hh, mm);
  } else {
    int y, m, d;
    civil(day, &y, &m, &d);
    snprintf(out, n, "%d %s %02d:%02d", d, months[m - 1], hh, mm);
  }
}

void missed_count_line(char *out, size_t n, bool callback, int count, const char *when) {
  const char *sep = when && when[0] ? " " : "";  // no clock yet: no time
  if (!when) when = "";
  if (callback) snprintf(out, n, "CALLED BACK%s%s", sep, when);
  else if (count > 1) snprintf(out, n, "%d CALLS%s%s", count, sep, when);
  else snprintf(out, n, "%s", when);
}
