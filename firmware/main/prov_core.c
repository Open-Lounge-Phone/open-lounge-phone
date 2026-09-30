#include "prov_core.h"

#include <stdio.h>
#include <string.h>

void prov_init(prov_t *p) { *p = (prov_t){.down_since = -1}; }

prov_action_t prov_step(prov_t *p, prov_event_t ev, bool has_creds, bool forced, int64_t now) {
  p->has_creds = has_creds;
  switch (ev) {
    case PROV_EV_BOOT:
      p->down_since = now;
      // Asked for, or nothing saved: it stays open until something is saved.
      p->forced = forced || !has_creds;
      if (forced || !has_creds) {
        p->ap_on = true;
        return PROV_ACT_START_AP;
      }
      return PROV_ACT_NONE;
    case PROV_EV_OPEN:
      p->forced = true;
      if (p->ap_on) return PROV_ACT_NONE;
      p->ap_on = true;
      return PROV_ACT_START_AP;
    case PROV_EV_STA_UP:
      p->sta_up = true;
      p->down_since = -1;
      // Back on the saved network: close the fallback setup network (not one that was asked for).
      if (p->ap_on && !p->forced) {
        p->ap_on = false;
        return PROV_ACT_STOP_AP;
      }
      return PROV_ACT_NONE;
    case PROV_EV_STA_DOWN:
      p->sta_up = false;
      if (p->down_since < 0) p->down_since = now;
      return PROV_ACT_NONE;
    case PROV_EV_TICK:
      if (!p->ap_on && !p->sta_up && p->down_since >= 0 && now - p->down_since >= PROV_FALLBACK_MS) {
        p->ap_on = true;  // the saved Wi-Fi is gone (moved, new password): offer setup
        return PROV_ACT_START_AP;
      }
      return PROV_ACT_NONE;
    case PROV_EV_SAVED:
      return PROV_ACT_REBOOT;
  }
  return PROV_ACT_NONE;
}

prov_hold_t prov_boot_hold(int held_ms) {
  if (held_ms >= PROV_HOLD_RESET_MS) return PROV_HOLD_RESET;
  if (held_ms >= PROV_HOLD_SETUP_MS) return PROV_HOLD_SETUP;
  return PROV_HOLD_NONE;
}

void prov_ap_ssid(const uint8_t mac[6], char *out, size_t n) {
  snprintf(out, n, "OpenLoungePhone-%02X%02X", mac[4], mac[5]);
}

void prov_ap_password(uint32_t random, char out[9]) {
  snprintf(out, 9, "%08lu", (unsigned long)(random % 100000000UL));
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

int prov_form_get(const char *body, const char *key, char *out, size_t n) {
  if (!body || !key || n == 0) return -1;
  size_t klen = strlen(key);
  const char *p = body;
  while (*p) {
    const char *end = strchr(p, '&');
    if (!end) end = p + strlen(p);
    if ((size_t)(end - p) > klen && !strncmp(p, key, klen) && p[klen] == '=') {
      size_t o = 0;
      for (const char *v = p + klen + 1; v < end; v++) {
        char c = *v;
        if (c == '+') {
          c = ' ';
        } else if (c == '%') {
          int hi = v + 2 < end ? hexval(v[1]) : -1, lo = v + 2 < end ? hexval(v[2]) : -1;
          if (hi < 0 || lo < 0) return -1;
          c = (char)(hi << 4 | lo);
          v += 2;
        }
        if (o + 1 >= n) return -1;
        out[o++] = c;
      }
      out[o] = '\0';
      if (strlen(out) != o) return -1;  // an encoded NUL: refuse
      return (int)o;
    }
    if ((size_t)(end - p) == klen && !strncmp(p, key, klen)) {  // "key" without "="
      out[0] = '\0';
      return 0;
    }
    p = *end ? end + 1 : end;
  }
  return -1;
}

const char *prov_check(const char *ssid, const char *pass) {
  size_t s = strlen(ssid), k = strlen(pass);
  if (s == 0) return "Pick or type a network name.";
  if (s > 32) return "That network name is too long.";
  if (k == 0) return NULL;  // an open network
  if (k < 8) return "Wi-Fi passwords have at least 8 characters.";
  if (k > 64) return "That password is too long.";
  if (k == 64) {
    for (size_t i = 0; i < 64; i++)
      if (hexval(pass[i]) < 0) return "That password doesn't look right. Check it and try again.";
  }
  return NULL;
}

int prov_scan_tidy(prov_ap_t *aps, int n) {
  // Strongest first (insertion sort: n is small), then drop hidden names and repeats.
  for (int i = 1; i < n; i++) {
    prov_ap_t x = aps[i];
    int j = i - 1;
    while (j >= 0 && aps[j].rssi < x.rssi) {
      aps[j + 1] = aps[j];
      j--;
    }
    aps[j + 1] = x;
  }
  int out = 0;
  for (int i = 0; i < n; i++) {
    if (!aps[i].ssid[0]) continue;
    bool seen = false;
    for (int j = 0; j < out && !seen; j++) seen = !strcmp(aps[j].ssid, aps[i].ssid);
    if (!seen) aps[out++] = aps[i];
  }
  return out;
}

size_t prov_html_escape(const char *in, char *out, size_t n) {
  size_t o = 0;
  if (n == 0) return 0;
  for (; *in; in++) {
    const char *rep = NULL;
    switch (*in) {
      case '&': rep = "&amp;"; break;
      case '<': rep = "&lt;"; break;
      case '>': rep = "&gt;"; break;
      case '"': rep = "&quot;"; break;
      case '\'': rep = "&#39;"; break;
    }
    size_t len = rep ? strlen(rep) : 1;
    if (o + len >= n) break;
    if (rep) memcpy(out + o, rep, len);
    else out[o] = *in;
    o += len;
  }
  out[o] = '\0';
  return o;
}

size_t prov_dns_answer(const uint8_t *q, size_t qlen, uint8_t *out, size_t outlen, uint32_t ip) {
  if (qlen < 12 || qlen > 512) return 0;
  uint16_t flags = (uint16_t)(q[2] << 8 | q[3]);
  uint16_t qd = (uint16_t)(q[4] << 8 | q[5]);
  if ((flags & 0x8000) || ((flags >> 11) & 0xF) != 0 || qd != 1) return 0;  // queries only
  // Walk the question name (labels; no compression in questions).
  size_t i = 12;
  while (i < qlen && q[i] != 0) {
    if (q[i] & 0xC0) return 0;
    i += (size_t)q[i] + 1;
  }
  if (i + 5 > qlen) return 0;
  size_t qend = i + 5;  // the zero byte + QTYPE + QCLASS
  uint16_t qtype = (uint16_t)(q[i + 1] << 8 | q[i + 2]);
  bool answer = qtype == 1 || qtype == 255;  // A or ANY
  size_t len = qend + (answer ? 16 : 0);
  if (len > outlen) return 0;
  memcpy(out, q, qend);
  out[2] = 0x84 | (q[2] & 0x01);  // response, authoritative, keep RD
  out[3] = 0x00;                  // no error
  out[6] = 0;
  out[7] = answer ? 1 : 0;        // ANCOUNT
  out[8] = out[9] = out[10] = out[11] = 0;
  if (answer) {
    uint8_t *a = out + qend;
    a[0] = 0xC0;
    a[1] = 12;             // name: pointer to the question
    a[2] = 0; a[3] = 1;    // type A
    a[4] = 0; a[5] = 1;    // class IN
    a[6] = 0; a[7] = 0; a[8] = 0; a[9] = 60;  // TTL 60 s
    a[10] = 0; a[11] = 4;
    memcpy(a + 12, &ip, 4);  // already in network byte order
  }
  return len;
}
