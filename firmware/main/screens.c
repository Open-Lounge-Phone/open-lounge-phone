#include "screens.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "boot_logo.h"
#include "gfx.h"
#include "marquee.h"
#include "qrcode.h"

void screen_boot(uint8_t *fb, int w, int h, const char *version) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  int s = 3, gap = 14;
  int tw = gfx_text_width("LOUNGE", s);
  int x0 = (w - (BOOT_LOGO_W + gap + tw)) / 2, y0 = (h - BOOT_LOGO_H) / 2;
  gfx_bitmap(fb, w, h, x0, y0, BOOT_LOGO, BOOT_LOGO_W, BOOT_LOGO_H);
  int tx = x0 + BOOT_LOGO_W + gap, line = 7 * s, lg = (BOOT_LOGO_H - 3 * line) / 2;
  gfx_text_at(fb, w, h, tx, y0, "OPEN", s, true);
  gfx_text_at(fb, w, h, tx, y0 + line + lg, "LOUNGE", s, true);
  gfx_text_at(fb, w, h, tx, y0 + 2 * (line + lg), "PHONE", s, true);
  gfx_text_at(fb, w, h, w - gfx_text_width(version, 1) - 4, h - 10, version, 1, true);
}

static uint8_t *s_qr_fb;
static int s_qr_w, s_qr_h, s_qr_x, s_qr_y, s_qr_px, s_qr_side;

static void draw_qr(esp_qrcode_handle_t q) {
  int n = esp_qrcode_get_size(q);
  int room = s_qr_h - 8;
  s_qr_px = room / (n + 2) > 4 ? 4 : room / (n + 2);
  int side = (n + 2) * s_qr_px;
  s_qr_side = side;
  s_qr_x = 4;
  s_qr_y = (s_qr_h - side) / 2;
  for (int y = 0; y < n; y++)
    for (int x = 0; x < n; x++)
      if (esp_qrcode_get_module(q, x, y))
        gfx_rect(s_qr_fb, s_qr_w, s_qr_h, s_qr_x + (x + 1) * s_qr_px, s_qr_y + (y + 1) * s_qr_px, s_qr_px,
                 s_qr_px, true);
}

/** Wi-Fi QR text (WIFI:T:WPA;S:..;P:..;;), with \ ; , : " escaped. */
static void wifi_qr_text(char *out, size_t n, const char *ssid, const char *pass) {
  size_t k = 0;
  const char *parts[] = {"WIFI:T:WPA;S:", ssid, ";P:", pass, ";;"};
  for (int i = 0; i < 5; i++)
    for (const char *c = parts[i]; *c && k + 2 < n; c++) {
      if ((i == 1 || i == 3) && strchr("\\;,:\"", *c)) out[k++] = '\\';
      out[k++] = *c;
    }
  out[k] = '\0';
}

void screen_setup(uint8_t *fb, int w, int h, const char *ssid, const char *pass) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  char text[160];
  wifi_qr_text(text, sizeof text, ssid, pass);
  s_qr_fb = fb;
  s_qr_w = w;
  s_qr_h = h;
  s_qr_px = 0;
  s_qr_side = 0;
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = draw_qr;
  cfg.max_qrcode_version = 6;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;
  esp_qrcode_generate(&cfg, text);
  int x = s_qr_px ? s_qr_x + s_qr_side + 8 : 8;
  int y = 10;
  gfx_text_at(fb, w, h, x, y, "SCAN TO", 2, true);
  gfx_text_at(fb, w, h, x, y + 18, "SET UP", 2, true);
  gfx_rect(fb, w, h, x, y + 40, w - x - 6, 1, true);
  char line[40];
  gfx_text_at(fb, w, h, x, y + 50, "OR JOIN", 1, true);
  snprintf(line, sizeof line, "%.24s", ssid);
  gfx_text_at(fb, w, h, x, y + 62, line, 1, true);
  snprintf(line, sizeof line, "PW %s", pass);
  gfx_text_at(fb, w, h, x, y + 74, line, 1, true);
  gfx_text_at(fb, w, h, x, y + 90, "OPEN 192.168.4.1", 1, true);
}

static void row(uint8_t *fb, int w, int h, int y, const char *label, const char *value) {
  gfx_text_at(fb, w, h, 8, y, label, 1, true);
  gfx_text_at(fb, w, h, 8 + 6 * 11, y, value, 1, true);
}

/** The logo at half size (a pixel is inked when any of its 2 × 2 source pixels is). */
static void logo_half(uint8_t *fb, int w, int h, int x0, int y0) {
  int row = (BOOT_LOGO_W + 7) / 8;
  for (int y = 0; y < BOOT_LOGO_H / 2; y++)
    for (int x = 0; x < BOOT_LOGO_W / 2; x++) {
      bool on = false;
      for (int dy = 0; dy < 2 && !on; dy++)
        for (int dx = 0; dx < 2 && !on; dx++) {
          int sx = 2 * x + dx, sy = 2 * y + dy;
          on = BOOT_LOGO[sy * row + sx / 8] & (0x80 >> (sx % 8));
        }
      if (on) gfx_rect(fb, w, h, x0 + x, y0 + y, 1, 1, true);
    }
}

void screen_about(uint8_t *fb, int w, int h, const char *fw, const char *board, const char *server,
                  const char *const *words) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  // The brand: the mark and the name, so whoever picks up the phone sees what it is.
  logo_half(fb, w, h, 8, 4);
  int tx = 8 + BOOT_LOGO_W / 2 + 8;
  gfx_text_at(fb, w, h, tx, 6, "OPEN LOUNGE", 2, true);
  gfx_text_at(fb, w, h, tx, 24, "PHONE", 2, true);
  gfx_rect(fb, w, h, 0, 43, w, 1, true);
  char v[48];
  snprintf(v, sizeof v, "%.30s", fw);
  row(fb, w, h, 48, "FIRMWARE", v);
  snprintf(v, sizeof v, "%.30s", board);
  for (char *c = v; *c; c++) *c = (char)toupper((unsigned char)*c);
  row(fb, w, h, 59, "BOARD", v);
  snprintf(v, sizeof v, "%.30s", server && server[0] ? server : "NOT SET");
  for (char *c = v; *c; c++) *c = (char)toupper((unsigned char)*c);
  row(fb, w, h, 70, "SERVER", v);
  for (int x = 8; x < w - 8; x += 3) gfx_rect(fb, w, h, x, 81, 1, 1, true);  // dotted rule
  gfx_text_at(fb, w, h, 8, 85, "PUBLIC KEY PART (MATCHES THE APP)", 1, true);
  char key[64];
  snprintf(key, sizeof key, "%s-%s-%s-%s", words[0], words[1], words[2], words[3]);
  for (char *c = key; *c; c++) *c = (char)toupper((unsigned char)*c);
  int s = gfx_text_width(key, 2) <= w - 16 ? 2 : 1;  // big when it fits
  gfx_text_at(fb, w, h, 8, s == 2 ? 95 : 98, key, s, true);
  // Open source, and where to find it: inverted bar along the bottom.
  gfx_rect(fb, w, h, 0, h - 11, w, 11, true);
  const char *foot = "OPEN SOURCE  OPENLOUNGEPHONE.APP";
  gfx_text_at(fb, w, h, (w - gfx_text_width(foot, 1)) / 2, h - 9, foot, 1, false);
}

void screen_page(uint8_t *fb, int w, int h, const char *title, const char *const rows[][2], int n,
                 const char *footer) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  gfx_rect(fb, w, h, 0, 0, w, 22, true);  // title bar
  gfx_text_at(fb, w, h, (w - gfx_text_width(title, 2)) / 2, 4, title, 2, false);
  int room = (footer ? h - 14 : h) - 28;
  int pitch = n > 0 && room / n < 12 ? room / n : 12;
  for (int i = 0; i < n; i++) {
    char v[48];
    snprintf(v, sizeof v, "%.29s", rows[i][1] ? rows[i][1] : "");
    for (char *c = v; *c; c++) *c = (char)toupper((unsigned char)*c);
    row(fb, w, h, 28 + i * pitch, rows[i][0], v);
  }
  if (footer) {
    for (int x = 8; x < w - 8; x += 3) gfx_rect(fb, w, h, x, h - 15, 1, 1, true);  // dotted rule
    gfx_text_at(fb, w, h, 8, h - 10, footer, 1, true);
  }
}

/** Key map geometry, shared by drawing and the "does anything scroll" check. */
#define KEYS_TOP 26
#define KEYS_CAP_W 16
static int keys_col(int w) { return (w - 8) / 2; }
static int keys_room(int w) { return keys_col(w) - KEYS_CAP_W - 10; }  // pixels for a name
static int chars_in(int px, int scale) { return (px + scale) / (6 * scale); }

bool screen_keys_scrolls(int w, int h, const char *title, const char *const labels[10],
                         const char *footer) {
  (void)h;
  if ((int)strlen(title) > chars_in(w - 8, 2) || (int)strlen(footer) > chars_in(w - 8, 1))
    return true;
  for (int i = 0; i < 10; i++)
    if (labels[i] && (int)strlen(labels[i]) > chars_in(keys_room(w), 1)) return true;
  return false;
}

void screen_keys(uint8_t *fb, int w, int h, const char *title, const char *const labels[10],
                 const char *footer, long step) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  gfx_rect(fb, w, h, 0, 0, w, 22, true);  // title bar
  char t[48];
  marquee(t, sizeof t, title, chars_in(w - 8, 2), step);
  gfx_text_at(fb, w, h, (w - gfx_text_width(t, 2)) / 2, 4, t, 2, false);

  // Two columns like the two key rows: 1-5 on the left, 6-0 on the right.
  int top = KEYS_TOP, bottom = h - 14, pitch = (bottom - top) / 5, col = keys_col(w);
  for (int i = 0; i < 10; i++) {
    int x = 4 + (i / 5) * col, y = top + (i % 5) * pitch;
    const char *label = labels[i] && labels[i][0] ? labels[i] : NULL;
    char digit[2] = {(char)(i == 9 ? '0' : '1' + i), 0};
    // The digit as a little keycap: filled when someone is on it, plain when not.
    int kw = KEYS_CAP_W, kh = pitch - 1 < 15 ? pitch - 1 : 15;
    int ds = kh >= 15 ? 2 : 1;
    if (label) gfx_rect(fb, w, h, x, y, kw, kh, true);
    gfx_text_at(fb, w, h, x + (kw - gfx_text_width(digit, ds) + 1) / 2, y + (kh - 7 * ds + 1) / 2,
                digit, ds, !label);
    char upper_name[48], name[48];
    int room = keys_room(w);
    snprintf(upper_name, sizeof upper_name, "%s", label ? label : "-");
    for (char *c = upper_name; *c; c++) *c = (char)toupper((unsigned char)*c);
    // Big when it fits, else small; longer than that scrolls.
    int s = gfx_text_width(upper_name, 2) <= room && kh >= 14 ? 2 : 1;
    marquee(name, sizeof name, upper_name, chars_in(room, s), step);
    gfx_text_at(fb, w, h, x + kw + 5, y + (kh - 7 * s) / 2, name, s, true);
  }
  for (int x = 8; x < w - 8; x += 3) gfx_rect(fb, w, h, x, h - 13, 1, 1, true);  // dotted rule
  char f[96];
  marquee(f, sizeof f, footer, chars_in(w - 8, 1), step);
  gfx_text_at(fb, w, h, (w - gfx_text_width(f, 1)) / 2, h - 9, f, 1, true);
}

void screen_lounge(uint8_t *fb, int w, int h, const char *url, const char *space, const char *hint) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  s_qr_fb = fb;
  s_qr_w = w;
  s_qr_h = h;
  s_qr_px = 0;
  s_qr_side = 0;
  esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
  cfg.display_func = draw_qr;
  cfg.max_qrcode_version = 8;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;
  esp_qrcode_generate(&cfg, url);
  int x = s_qr_px ? s_qr_x + s_qr_side + 8 : 8, right = w - x - 4;
  gfx_text_at(fb, w, h, x, 10, "SCAN TO", 2, true);
  gfx_text_at(fb, w, h, x, 28, "USE THIS", 2, true);
  gfx_text_at(fb, w, h, x, 46, "PHONE", 2, true);
  gfx_rect(fb, w, h, x, 68, right, 1, true);
  char line[48];
  snprintf(line, sizeof line, "%s", hint ? hint : "");
  while (gfx_text_width(line, 1) > right && strlen(line) > 1) line[strlen(line) - 1] = '\0';
  gfx_text_at(fb, w, h, x, 76, line, 1, true);
  snprintf(line, sizeof line, "%s", space ? space : "");
  for (char *c = line; *c; c++) *c = (char)toupper((unsigned char)*c);
  while (gfx_text_width(line, 1) > right && strlen(line) > 1) line[strlen(line) - 1] = '\0';
  gfx_text_at(fb, w, h, x, h - 12, line, 1, true);
}
