#include "screens.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "boot_logo.h"
#include "gfx.h"
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

void screen_about(uint8_t *fb, int w, int h, const char *fw, const char *board, const char *server,
                  const char *const *words) {
  memset(fb, 0, (size_t)(w * h + 7) / 8);
  gfx_rect(fb, w, h, 0, 0, w, 22, true);  // title bar
  gfx_text_at(fb, w, h, (w - gfx_text_width("ABOUT THIS PHONE", 2)) / 2, 4, "ABOUT THIS PHONE", 2, false);
  char v[48];
  snprintf(v, sizeof v, "%.30s", fw);
  row(fb, w, h, 30, "FIRMWARE", v);
  snprintf(v, sizeof v, "%.30s", board);
  for (char *c = v; *c; c++) *c = (char)toupper((unsigned char)*c);
  row(fb, w, h, 42, "BOARD", v);
  snprintf(v, sizeof v, "%.30s", server && server[0] ? server : "NOT SET");
  for (char *c = v; *c; c++) *c = (char)toupper((unsigned char)*c);
  row(fb, w, h, 54, "SERVER", v);
  for (int x = 8; x < w - 8; x += 3) gfx_rect(fb, w, h, x, 67, 1, 1, true);  // dotted rule
  gfx_text_at(fb, w, h, 8, 74, "PUBLIC KEY PART", 1, true);
  char key[64];
  snprintf(key, sizeof key, "%s-%s-%s-%s", words[0], words[1], words[2], words[3]);
  for (char *c = key; *c; c++) *c = (char)toupper((unsigned char)*c);
  int s = gfx_text_width(key, 2) <= w - 16 ? 2 : 1;  // big when it fits
  gfx_text_at(fb, w, h, 8, 86, key, s, true);
  gfx_text_at(fb, w, h, 8, h - 11, "SAME WORDS IN THE APP = THIS PHONE", 1, true);
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
