#include "proto.h"

#include <stdlib.h>
#include <string.h>

#include "esp_log.h"
#include "net.h"

static const char *TAG = "proto";

bool proto_send(cJSON *msg) {
  char *text = cJSON_PrintUnformatted(msg);
  cJSON_Delete(msg);
  if (!text) return false;
  bool ok = false;
  if (strlen(text) > MAX_MESSAGE_BYTES) {
    ESP_LOGE(TAG, "message too large (%u bytes): not sent", (unsigned)strlen(text));
  } else {
    ok = net_ws_send(text);
    ESP_LOGI(TAG, "%s %s", ok ? "->" : "-> (not sent)", text);
  }
  free(text);
  return ok;
}

bool proto_ping(void) { return net_ws_send("{\"t\":\"ping\"}"); }
