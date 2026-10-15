#include "eth.h"

#if BOARD_HAS_ETHERNET
#include <stdio.h>
#include <string.h>

#include "app.h"
#include "board_spi.h"
#include "esp_eth.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "netsel.h"
#include "sdkconfig.h"

static const char *TAG = "eth";

#define W5500_SPI_HZ (16 * 1000 * 1000)  // the bus runs through the GPIO matrix: stay well below 20
#define W5500_POLL_MS 10                 // RX polling (no INTn GPIO): 10 ms ≤ half an audio frame
#define LINK_CHECK_MS 500                // how often the driver reads the link (one SPI read)
// The W5500's PHYCFGR (common register 0x002E; the driver's address map: offset << 16 | block << 3)
// and its values: RST (bit 7) low then high applies OPMD (bit 6) + OPMDC (bits 5:3).
#define W5500_PHYCFGR (0x002EU << 16)
#define PHYCFGR_ALL_CAPABLE 0xF8  // OPMD=1, OPMDC=111: 10/100, half/full, autonegotiation
#define PHYCFGR_POWER_DOWN 0xF0   // OPMD=1, OPMDC=110: power-down mode
#define PHYCFGR_RST 0x80

static esp_eth_handle_t s_eth;
static esp_netif_t *s_netif;
static bool s_present, s_phy_on;
static volatile bool s_link, s_has_ip;
static volatile int s_speed;
static volatile bool s_full;
static uint8_t s_mac[6];

bool eth_present(void) { return s_present; }
void *eth_netif(void) { return s_netif; }

void eth_info(eth_info_t *out) {
  *out = (eth_info_t){.present = s_present, .phy_on = s_phy_on, .link = s_link,
                      .speed_mbps = s_link ? s_speed : 0, .full_duplex = s_full,
                      .has_ip = s_has_ip};
  memcpy(out->mac, s_mac, sizeof s_mac);
  esp_netif_ip_info_t ip;
  if (s_has_ip && s_netif && esp_netif_get_ip_info(s_netif, &ip) == ESP_OK)
    snprintf(out->ip, sizeof out->ip, IPSTR, IP2STR(&ip.ip));
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
  if (base == ETH_EVENT && id == ETHERNET_EVENT_CONNECTED) {
    eth_speed_t speed = ETH_SPEED_10M;
    eth_duplex_t duplex = ETH_DUPLEX_HALF;
    esp_eth_ioctl(s_eth, ETH_CMD_G_SPEED, &speed);
    esp_eth_ioctl(s_eth, ETH_CMD_G_DUPLEX_MODE, &duplex);
    s_speed = speed == ETH_SPEED_100M ? 100 : 10;
    s_full = duplex == ETH_DUPLEX_FULL;
    s_link = true;
    ESP_LOGI(TAG, "ETH link up %d Mbit/s %s duplex", s_speed, s_full ? "full" : "half");
    app_post(EV_NET, NS_LINK_UP, NULL);
  } else if (base == ETH_EVENT && id == ETHERNET_EVENT_DISCONNECTED) {
    s_link = s_has_ip = false;
    ESP_LOGI(TAG, "ETH link down");
    app_post(EV_NET, NS_LINK_DOWN, NULL);
  } else if (base == IP_EVENT && id == IP_EVENT_ETH_GOT_IP) {
    const ip_event_got_ip_t *e = data;
    s_has_ip = true;
    ESP_LOGI(TAG, "ETH got ip=" IPSTR " gw=" IPSTR, IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw));
    app_post(EV_NET, NS_WIRED_IP, NULL);
  } else if (base == IP_EVENT && id == IP_EVENT_ETH_LOST_IP) {
    s_has_ip = false;
    ESP_LOGW(TAG, "ETH lost its address");
    app_post(EV_NET, NS_WIRED_IP_LOST, NULL);
  }
}

#if !CONFIG_OLP_QEMU
/** Writes PHYCFGR with the reset pulse that makes the W5500 take the new operation mode. */
static void phycfg(uint32_t value) {
  uint32_t v = value & ~PHYCFGR_RST;
  esp_eth_phy_reg_rw_data_t rw = {.reg_addr = W5500_PHYCFGR, .reg_value_p = &v};
  esp_err_t err = esp_eth_ioctl(s_eth, ETH_CMD_WRITE_PHY_REG, &rw);
  vTaskDelay(pdMS_TO_TICKS(10));  // the W5500's PHY reset time (the driver waits as long)
  v = value;
  if (err == ESP_OK) err = esp_eth_ioctl(s_eth, ETH_CMD_WRITE_PHY_REG, &rw);
  if (err != ESP_OK) ESP_LOGW(TAG, "PHYCFGR write 0x%02lx failed: %s", (unsigned long)value,
                              esp_err_to_name(err));
}
#endif

void eth_phy(bool on) {
  if (!s_present || on == s_phy_on) return;
  s_phy_on = on;
  ESP_LOGI(TAG, "ETH PHY %s", on ? "on (looking for a link)" : "off (power-down)");
#if CONFIG_OLP_QEMU
  // QEMU's PHY model can't power down: stopping the driver stands in for it (the link goes down,
  // nothing is polled), starting it again for the wake-up.
  esp_err_t err = on ? esp_eth_start(s_eth) : esp_eth_stop(s_eth);
  if (err != ESP_OK) ESP_LOGW(TAG, "ETH %s failed: %s", on ? "start" : "stop", esp_err_to_name(err));
#else
  // The driver keeps running (the link is read every LINK_CHECK_MS, one SPI read; RX polling stops
  // with the link): only the W5500's PHY sleeps or wakes. Powered down, its link bit drops and the
  // driver reports the link down; woken, it autonegotiates and the link (then DHCP) comes back.
  phycfg(on ? PHYCFGR_ALL_CAPABLE : PHYCFGR_POWER_DOWN);
#endif
}

#if CONFIG_OLP_QEMU
// ESP-IDF's OpenCores MAC clears RXEN/TXEN when the link goes down and sets them again when it
// comes back, and QEMU's model then starts again from its first buffer descriptor while the
// driver carries on from where it was: nothing is received after a cable is pulled and plugged
// back in. A link down needs nothing from the emulated MAC (QEMU drops frames while its link is
// down), so it is skipped here.
static esp_err_t (*s_openeth_set_link)(esp_eth_mac_t *mac, eth_link_t link);
static esp_err_t qemu_set_link(esp_eth_mac_t *mac, eth_link_t link) {
  return link == ETH_LINK_DOWN ? ESP_OK : s_openeth_set_link(mac, link);
}
#endif

bool eth_start(void) {
  esp_netif_inherent_config_t base = ESP_NETIF_INHERENT_DEFAULT_ETH();
  base.route_prio = 128;  // above Wi-Fi's 100: the cable is the default route when both have one
  esp_netif_config_t ncfg = {.base = &base, .stack = ESP_NETIF_NETSTACK_DEFAULT_ETH};
  s_netif = esp_netif_new(&ncfg);
  eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
  eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
  phy_cfg.reset_gpio_num = -1;  // no RSTn GPIO: its own power-on RC, then the driver's soft reset
#if CONFIG_OLP_QEMU
  // QEMU has no W5500: its OpenCores Ethernet is the cable (QEMU monitor `set_link` unplugs it).
  phy_cfg.autonego_timeout_ms = 100;
  esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mac_cfg);
  if (mac) {
    s_openeth_set_link = mac->set_link;
    mac->set_link = qemu_set_link;
  }
  esp_eth_phy_t *phy = esp_eth_phy_new_dp83848(&phy_cfg);
  const char *what = "QEMU Ethernet (standing in for the W5500)";
#else
  if (board_spi_init() != ESP_OK) {
    ESP_LOGE(TAG, "ETH: the SPI bus didn't start: no wired network");
    esp_netif_destroy(s_netif);
    s_netif = NULL;
    return false;
  }
  spi_device_interface_config_t dev = {
      .mode = 0,
      .clock_speed_hz = W5500_SPI_HZ,
      .spics_io_num = PIN_ETH_CS,
      .queue_size = 20,
  };
  eth_w5500_config_t w5500 = ETH_W5500_DEFAULT_CONFIG(BOARD_SPI_HOST, &dev);
  w5500.int_gpio_num = -1;  // INTn isn't wired: poll
  w5500.poll_period_ms = W5500_POLL_MS;
  phy_cfg.phy_addr = 1;  // unused by the W5500 (one PHY register), but must be valid
  esp_eth_mac_t *mac = esp_eth_mac_new_w5500(&w5500, &mac_cfg);
  esp_eth_phy_t *phy = esp_eth_phy_new_w5500(&phy_cfg);
  const char *what = "W5500";
#endif
  esp_eth_config_t cfg = ETH_DEFAULT_CONFIG(mac, phy);
  cfg.check_link_period_ms = LINK_CHECK_MS;
  esp_err_t err = mac && phy ? esp_eth_driver_install(&cfg, &s_eth) : ESP_ERR_NO_MEM;
  if (err != ESP_OK) {
    // A board without the chip fitted, or a dead SPI line: the phone carries on with Wi-Fi.
    ESP_LOGW(TAG, "ETH: no %s answering (CS IO%d, MISO IO%d): %s; Wi-Fi only", what, PIN_ETH_CS,
             PIN_ETH_MISO, esp_err_to_name(err));
    if (mac) mac->del(mac);
    if (phy) phy->del(phy);
    esp_netif_destroy(s_netif);
    s_netif = NULL;
    return false;
  }
  // The W5500 has no MAC address of its own: the chip's Ethernet one (eFuse base + 3).
  esp_read_mac(s_mac, ESP_MAC_ETH);
  esp_eth_ioctl(s_eth, ETH_CMD_S_MAC_ADDR, s_mac);
  ESP_ERROR_CHECK(esp_netif_attach(s_netif, esp_eth_new_netif_glue(s_eth)));
  ESP_ERROR_CHECK(esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, on_event, NULL));
  ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_LOST_IP, on_event, NULL));
  s_present = true;
  ESP_LOGI(TAG, "ETH %s ready, mac %02x:%02x:%02x:%02x:%02x:%02x", what, s_mac[0], s_mac[1],
           s_mac[2], s_mac[3], s_mac[4], s_mac[5]);
  // Power-on: the PHY on, looking for a cable first.
#if CONFIG_OLP_QEMU
  eth_phy(true);
#else
  phycfg(PHYCFGR_ALL_CAPABLE);  // out of a power-down a soft reset may have left (esp_eth_start
                                // restarts autonegotiation, which needs an autonegotiating mode)
  err = esp_eth_start(s_eth);
  if (err != ESP_OK) ESP_LOGW(TAG, "ETH start failed: %s", esp_err_to_name(err));
  s_phy_on = true;
  ESP_LOGI(TAG, "ETH PHY on (looking for a link)");
#endif
  return true;
}
#endif
