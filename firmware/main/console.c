// The serial console (USB-Serial-JTAG on the board, UART0 in the simulator):
//   wifi <ssid> [pass]   server <url>   status   key <0-9|menu|back>   hook <up|down>
//   drop [wifi]   wipe   screen   reboot   audio   volume   rtc   ice
// `key` and `hook` act like the real switches (for tests and bring-up).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "app.h"
#include "audio.h"
#include "media.h"
#include "display.h"
#include "esp_console.h"
#include "esp_log.h"
#include "ice.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "net.h"
#include "prov.h"
#include "ota.h"
#include "sdkconfig.h"

void app_print_status(void);  // main.c

static int cmd_wifi(int argc, char **argv) {
  if (argc < 2) {
    printf("usage: wifi <ssid> [password] | wifi forget\n");
    return 1;
  }
  if (!strcmp(argv[1], "forget")) {
    net_save_wifi("", "");  // an explicit "none": the Kconfig default isn't used either
    printf("wifi forgotten: the setup network opens after `reboot`\n");
    return 0;
  }
  net_set_wifi(argv[1], argc > 2 ? argv[2] : "");
  printf("wifi saved: %s\n", argv[1]);
  return 0;
}

static int cmd_server(int argc, char **argv) {
  char url[128];
  if (argc < 2) {
    net_server_url(url, sizeof url);
    printf("server: %s\n", url);
    return 0;
  }
  if (strncmp(argv[1], "wss://", 6) && strncmp(argv[1], "ws://", 5)) {
    printf("the server URL starts with wss:// (or ws:// for a local test server)\n");
    return 1;
  }
  net_set_server(argv[1]);
  printf("server saved: %s\n", argv[1]);
  app_post(EV_RECONNECT, 0, NULL);
  return 0;
}

static int cmd_status(int argc, char **argv) {
  app_print_status();
  return 0;
}

static int cmd_key(int argc, char **argv) {
  if (argc < 2) return 1;
  const char *k = argv[1];
  int index = -1;
  if (!strcasecmp(k, "menu")) index = 10;
  else if (!strcasecmp(k, "back")) index = 11;
  else if (strlen(k) == 1 && k[0] >= '0' && k[0] <= '9') index = k[0] == '0' ? 9 : k[0] - '1';
  if (index < 0) {
    printf("usage: key <0-9|menu|back>\n");
    return 1;
  }
  ESP_LOGI("input", "KEY %s (console)", k);
  app_post(EV_KEY, index, NULL);
  return 0;
}

static int cmd_hook(int argc, char **argv) {
  if (argc < 2 || (strcmp(argv[1], "up") && strcmp(argv[1], "down"))) {
    printf("usage: hook <up|down>\n");
    return 1;
  }
  ESP_LOGI("input", "HOOK %s (console)", argv[1]);
  app_post(EV_HOOK, !strcmp(argv[1], "up"), NULL);
  return 0;
}

static int cmd_drop(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "wifi")) {
    printf("dropping Wi-Fi (it reconnects)\n");
    esp_wifi_disconnect();
  } else {
    printf("dropping the WebSocket (it reconnects)\n");
    app_post(EV_DROP, 0, NULL);
  }
  return 0;
}

static int cmd_wipe(int argc, char **argv) {
  app_post(EV_WIPE, 0, NULL);
  return 0;
}

static int cmd_screen(int argc, char **argv) {
  display_dump();
  return 0;
}

static tone_t tone_by_name(const char *n) {
  for (int t = TONE_NONE; t <= TONE_TEST; t++)
    if (!strcasecmp(n, tone_name((tone_t)t))) return (tone_t)t;
  return TONE_NONE;
}

static int cmd_audio(int argc, char **argv) {
  if (argc >= 3 && !strcmp(argv[1], "tone")) {
    audio_force_tone(tone_by_name(argv[2]));
  } else if (argc >= 3 && !strcmp(argv[1], "loop")) {
    audio_loopback(strcmp(argv[2], "off") ? atoi(argv[2]) : 0);
  } else if (argc >= 3 && !strcmp(argv[1], "watch")) {
    audio_watch((float)atof(argv[2]));
  } else if (argc > 1) {
    printf("usage: audio [tone <dialtone|ringback|busy|hold|test|none>] [loop <ms>|off] "
           "[watch <hz>]\n");
    return 1;
  }
  audio_print_status();
  return 0;
}

static int cmd_volume(int argc, char **argv) {
  if (argc > 1) audio_set_volume(atoi(argv[1]));
  printf("volume %d/%d (%.0f dBFS; cap %d dBFS)\n", audio_volume(), VOLUME_MAX,
         audio_volume_db(audio_volume()), CONFIG_OLP_EARPIECE_MAX_DB);
  return 0;
}

static int cmd_rtc(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "log")) {
    esp_log_level_set("AGENT", argc > 2 && !strcmp(argv[2], "on") ? ESP_LOG_INFO : ESP_LOG_WARN);
    printf("esp_peer agent log %s (it prints TURN credentials: debugging only)\n",
           argc > 2 && !strcmp(argv[2], "on") ? "on" : "off");
    return 0;
  }
  media_print_status();
  return 0;
}

static int cmd_ice(int argc, char **argv) {
  if (argc > 1) {
    if (!strcmp(argv[1], "all")) media_set_ice_mode(ICE_ALL);
    else if (!strcmp(argv[1], "udp")) media_set_ice_mode(ICE_UDP);
    else if (!strcmp(argv[1], "tcp")) media_set_ice_mode(ICE_TCP);
    else if (!strcmp(argv[1], "tls")) media_set_ice_mode(ICE_TLS);
    else {
      printf("usage: ice [all|udp|tcp|tls]  (tcp/tls = relay over TURN TCP / TLS only)\n");
      return 1;
    }
  }
  printf("ice %s (next call)\n", ice_mode_name(media_ice_mode()));
  if (media_ice_mode() == ICE_TCP || media_ice_mode() == ICE_TLS)
    printf("note: TURN over TCP/TLS doesn't work in esp_peer 1.5.6 (README \"Call audio\")\n");
  return 0;
}

static int cmd_setup(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "test")) {
    prov_selftest(argc > 2 ? argv[2] : NULL, argc > 3 ? argv[3] : "");
    return 0;
  }
  if (argc > 1) {
    printf("usage: setup [test [ssid [password]]]\n");
    return 1;
  }
  app_post(EV_PROV_OPEN, 0, NULL);
  printf("opening the Wi-Fi setup network\n");
  return 0;
}

static int cmd_ota(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "check")) {
    ota_check(false);
  } else if (argc >= 2 && !strcmp(argv[1], "now")) {
    app_post(EV_OTA_NOW, 0, NULL);
  } else if (argc >= 3 && !strcmp(argv[1], "url")) {
    ota_set_manifest_url(strcmp(argv[2], "default") ? argv[2] : NULL);
  } else if (argc > 1) {
    printf("usage: ota [check | now | url <https://…/manifest.json> | url default]\n");
    return 1;
  }
  ota_print_status();
  return 0;
}

static int cmd_reboot(int argc, char **argv) {
  esp_restart();
  return 0;
}

void console_start(void) {
  esp_console_repl_t *repl = NULL;
  esp_console_repl_config_t cfg = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
  cfg.prompt = "olp>";
  cfg.max_cmdline_length = 384;
#if CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG
  esp_console_dev_usb_serial_jtag_config_t dev = ESP_CONSOLE_DEV_USB_SERIAL_JTAG_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_console_new_repl_usb_serial_jtag(&dev, &cfg, &repl));
#else
  esp_console_dev_uart_config_t dev = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_console_new_repl_uart(&dev, &cfg, &repl));
#endif
  const esp_console_cmd_t cmds[] = {
      {.command = "wifi", .help = "wifi <ssid> [password] | wifi forget: save (or forget) Wi-Fi", .func = cmd_wifi},
      {.command = "server", .help = "server [wss://host]: show or set the server", .func = cmd_server},
      {.command = "status", .help = "phone, connection and Wi-Fi state", .func = cmd_status},
      {.command = "key", .help = "key <0-9|menu|back>: press a key", .func = cmd_key},
      {.command = "hook", .help = "hook <up|down>: lift or hang up the handset", .func = cmd_hook},
      {.command = "drop", .help = "drop [wifi]: drop the WebSocket (or Wi-Fi) to test reconnects",
       .func = cmd_drop},
      {.command = "wipe", .help = "forget the device key, id and settings (keeps Wi-Fi)", .func = cmd_wipe},
      {.command = "screen", .help = "print the display's framebuffer (tools/fb2png.py)", .func = cmd_screen},
      {.command = "audio", .help = "audio [tone <name>|loop <ms>|off|watch <hz>]: audio state and bring-up tests",
       .func = cmd_audio},
      {.command = "volume", .help = "volume [0-10]: earpiece volume (10 = the cap)", .func = cmd_volume},
      {.command = "rtc", .help = "rtc [log on|off]: call media (WebRTC) state", .func = cmd_rtc},
      {.command = "ice", .help = "ice [all|udp|tcp|tls]: which ICE servers the next call uses", .func = cmd_ice},
      {.command = "setup", .help = "setup [test [ssid [pass]]]: open the Wi-Fi setup network (test: fetch/post its page from the phone)",
       .func = cmd_setup},
      {.command = "ota", .help = "ota [check|now|url <u>|url default]: firmware updates", .func = cmd_ota},
      {.command = "reboot", .help = "restart", .func = cmd_reboot},
  };
  for (size_t i = 0; i < sizeof cmds / sizeof cmds[0]; i++)
    ESP_ERROR_CHECK(esp_console_cmd_register(&cmds[i]));
  ESP_ERROR_CHECK(esp_console_start_repl(repl));
}
