#include "labs_web.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "labs_cfg.h"
#include "labs_ic.h"
#include "mdns.h"

static const char *TAG = "labs_web";

const labs_cfg_t *labs_cfg(void);
bool labs_cfg_set(const labs_cfg_t *c);
bool labs_pin_ok(int pin);
const ic_t *labs_ic(void);

static httpd_handle_t s_srv;
static char s_session[33];      // the cookie after the PIN ("" = nobody signed in)
static int s_fails;
static int64_t s_locked_until;

static const char PAGE[] =
"<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
"<title>Open Lounge Phone labs</title><style>"
"body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#f6f4ef;color:#1d2321}"
"main{max-width:760px;margin:auto;padding:16px}h1{font-size:22px;margin:.2em 0}"
"fieldset{border:1px solid #dcd8ce;border-radius:10px;margin:14px 0;padding:10px 12px;background:#fff}"
"legend{font-weight:600;padding:0 6px}label{display:block;margin:6px 0 2px;font-size:13px;color:#5e6a66}"
"input,select{font:inherit;padding:6px 8px;border:1px solid #cfd3d1;border-radius:6px;width:100%;box-sizing:border-box}"
".row{display:grid;grid-template-columns:2.2em 8em 1fr 1fr;gap:6px;align-items:center;margin:4px 0}"
".row b{text-align:center}button{font:inherit;padding:8px 16px;border-radius:999px;border:0;background:#2f6f5e;color:#fff;cursor:pointer}"
".muted{color:#5e6a66;font-size:13px}#msg{margin-left:10px}@media(max-width:560px){.row{grid-template-columns:2em 1fr}}"
"</style><main><h1>Open Lounge Phone labs</h1><p class=muted id=who></p>"
"<form id=login hidden><label>PIN (on the phone: MENU, then 5)</label><input id=pin inputmode=numeric maxlength=4>"
"<p><button>Unlock</button> <span id=lmsg class=muted></span></p></form>"
"<form id=f hidden>"
"<fieldset><legend>This phone</legend><label>Room name</label><input id=name maxlength=24>"
"<label>Mode (what it shows when idle)</label><select id=mode>"
"<option value=phone>Phone (speed dial)</option><option value=intercom>House intercom</option>"
"<option value=checkin>Daily check-in</option><option value=macro>Macro pad (USB keyboard)</option>"
"<option value=home>Home panel</option><option value=doorbell>Doorbell</option></select></fieldset>"
"<fieldset><legend>Keys</legend><p class=muted>Action: phone = the speed dial from your server. "
"intercom: target = a room. all: rings every room. chime: target = the words. ha: service (scene.turn_on) "
"+ target (an entity). story: url of an 8 kHz WAV. macro: target = ctrl+shift+m, f13, mute, play. "
"checkin: I'm OK. doorbell: rings the house (target = one room).</p><div id=keys></div></fieldset>"
"<fieldset><legend>Home Assistant</legend><label>Address</label><input id=haurl placeholder='http://homeassistant.local:8123'>"
"<label>Access token (stays on the phone; leave blank to keep)</label><input id=hatoken type=password autocomplete=off>"
"<label>Status entity (shown on the home panel)</label><input id=hastatus placeholder='cover.garage_door'>"
"<label>Its name on screen</label><input id=halabel placeholder='GARAGE' maxlength=24></fieldset>"
"<fieldset><legend>Daily check-in</legend><label>Press I'm OK by (blank = off)</label><input id=by placeholder='10:00'>"
"<label>Reminders, one a line: 08:30 PILLS</label><textarea id=rem rows=4 style='width:100%;font:inherit'></textarea>"
"<p class=muted>Missed: your server tells the family (an alert in their voicemail).</p></fieldset>"
"<fieldset><legend>Doorbell</legend><label>What the house phones say</label><input id=door maxlength=24></fieldset>"
"<p><button>Save</button><span id=msg class=muted></span></p><p class=muted id=peers></p></form></main><script>"
"const A=['phone','intercom','all','chime','ha','story','macro','checkin','doorbell'],D='1234567890';"
"const $=i=>document.getElementById(i);"
"async function load(){const r=await fetch('/api/config');if(r.status==401){$('login').hidden=false;return}"
"const c=await r.json();$('f').hidden=false;$('login').hidden=true;$('who').textContent=c.name+' · '+(c.peers||[]).length+' other rooms on this Wi-Fi';"
"$('name').value=c.name;$('mode').value=c.mode;const k={};(c.keys||[]).forEach(x=>k[x.key]=x);"
"$('keys').innerHTML=[...D].map(d=>{const x=k[d]||{action:'phone'};return `<div class=row><b>${d}</b><select data-d=${d} data-f=action>${A.map(a=>`<option${a==x.action?' selected':''}>${a}</option>`).join('')}</select>`+"
"`<input data-d=${d} data-f=label placeholder=label value='${(x.label||'').replace(/'/g,'&#39;')}'><input data-d=${d} data-f=target placeholder='target / url' value='${(x.url||x.target||'').replace(/'/g,'&#39;')}'>`+"
"`<input data-d=${d} data-f=service placeholder='service (ha)' value='${x.service||''}' style='grid-column:3/5'></div>`}).join('');"
"$('haurl').value=c.ha.url;$('hastatus').value=c.ha.status;$('halabel').value=c.ha.status_label;$('hatoken').placeholder=c.ha.token_set?'(saved)':'';"
"$('by').value=c.checkin.by;$('rem').value=c.checkin.reminders.map(r=>r.at+' '+r.text).join('\\n');$('door').value=c.door_label;"
"$('peers').textContent=(c.peers||[]).length?'Rooms here: '+c.peers.join(', '):''}"
"$('login').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',body:JSON.stringify({pin:+$('pin').value})});"
"if(r.ok)load();else $('lmsg').textContent=r.status==429?'Too many tries: wait a minute':'Wrong PIN'};"
"$('f').onsubmit=async e=>{e.preventDefault();const keys=[...D].map(d=>{const g=f=>document.querySelector(`[data-d='${d}'][data-f=${f}]`).value.trim();"
"const a=g('action'),t=g('target');const o={key:d,action:a};if(g('label'))o.label=g('label');if(a=='story')o.url=t;else if(t)o.target=t;if(g('service'))o.service=g('service');return o})"
".filter(o=>o.action!='phone'||o.label);"
"const rem=$('rem').value.split('\\n').map(l=>l.trim()).filter(Boolean).map(l=>({at:l.slice(0,5),text:l.slice(5).trim()}));"
"const body={name:$('name').value,mode:$('mode').value,keys,ha:{url:$('haurl').value,token:$('hatoken').value,status:$('hastatus').value,status_label:$('halabel').value},"
"checkin:{by:$('by').value,reminders:rem},door_label:$('door').value};"
"const r=await fetch('/api/config',{method:'POST',body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));"
"$('msg').textContent=r.ok?(j.restart?'Saved: the phone restarts':'Saved'):(j.error||'Not saved');if(r.ok){$('hatoken').value='';if(!j.restart)load()}};"
"load()</script>";

static bool authed(httpd_req_t *req) {
  char cookie[80];
  if (!s_session[0] || httpd_req_get_hdr_value_str(req, "Cookie", cookie, sizeof cookie) != ESP_OK) return false;
  char want[48];
  snprintf(want, sizeof want, "olp=%s", s_session);
  return strstr(cookie, want) != NULL;
}

static char *body(httpd_req_t *req, size_t max) {
  if (req->content_len == 0 || req->content_len > max) return NULL;
  char *b = malloc(req->content_len + 1);
  if (!b) return NULL;
  size_t got = 0;
  while (got < req->content_len) {
    int n = httpd_req_recv(req, b + got, req->content_len - got);
    if (n <= 0) { free(b); return NULL; }
    got += n;
  }
  b[got] = '\0';
  return b;
}

static esp_err_t json_reply(httpd_req_t *req, const char *status, const char *json) {
  httpd_resp_set_status(req, status);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  return httpd_resp_sendstr(req, json);
}

static esp_err_t h_page(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, PAGE, sizeof PAGE - 1);
}

static esp_err_t h_login(httpd_req_t *req) {
  int64_t now = esp_timer_get_time() / 1000;
  if (now < s_locked_until) return json_reply(req, "429 Too Many Requests", "{\"error\":\"wait\"}");
  char *b = body(req, 128);
  cJSON *j = cJSON_Parse(b ? b : "");
  const cJSON *pin = cJSON_GetObjectItemCaseSensitive(j, "pin");
  bool ok = cJSON_IsNumber(pin) && labs_pin_ok(pin->valueint);
  cJSON_Delete(j);
  free(b);
  if (!ok) {
    if (++s_fails >= 5) { s_fails = 0; s_locked_until = now + 60000; }
    return json_reply(req, "403 Forbidden", "{\"error\":\"wrong PIN\"}");
  }
  s_fails = 0;
  for (int i = 0; i < 16; i++) snprintf(s_session + 2 * i, 3, "%02x", (unsigned)(esp_random() & 0xff));
  char cookie[80];
  snprintf(cookie, sizeof cookie, "olp=%s; Path=/; HttpOnly; SameSite=Strict", s_session);
  httpd_resp_set_hdr(req, "Set-Cookie", cookie);
  return json_reply(req, "200 OK", "{\"ok\":true}");
}

static esp_err_t h_get(httpd_req_t *req) {
  if (!authed(req)) return json_reply(req, "401 Unauthorized", "{\"error\":\"PIN\"}");
  char *cfg = labs_cfg_json(labs_cfg(), false);
  cJSON *j = cJSON_Parse(cfg ? cfg : "{}");
  free(cfg);
  cJSON *peers = cJSON_AddArrayToObject(j, "peers");
  const ic_t *ic = labs_ic();
  int64_t now = esp_timer_get_time() / 1000;
  for (int i = 0; i < IC_PEERS; i++)
    if (ic->peers[i].name[0] && now - ic->peers[i].seen < IC_PEER_MS)
      cJSON_AddItemToArray(peers, cJSON_CreateString(ic->peers[i].name));
  char *out = cJSON_PrintUnformatted(j);
  cJSON_Delete(j);
  esp_err_t e = json_reply(req, "200 OK", out ? out : "{}");
  free(out);
  return e;
}

static void restart_task(void *arg) {
  vTaskDelay(pdMS_TO_TICKS(800));
  esp_restart();
}

static esp_err_t h_post(httpd_req_t *req) {
  if (!authed(req)) return json_reply(req, "401 Unauthorized", "{\"error\":\"PIN\"}");
  char *b = body(req, 6000);
  if (!b) return json_reply(req, "400 Bad Request", "{\"error\":\"empty or too big\"}");
  labs_cfg_t next;
  char err[96] = "";
  bool ok = labs_cfg_parse(b, labs_cfg(), &next, err, sizeof err);
  free(b);
  if (!ok) {
    cJSON *e = cJSON_CreateObject();
    cJSON_AddStringToObject(e, "error", err);
    char *s = cJSON_PrintUnformatted(e);
    cJSON_Delete(e);
    esp_err_t r = json_reply(req, "400 Bad Request", s);
    free(s);
    return r;
  }
  bool restart = labs_cfg_set(&next);
  json_reply(req, "200 OK", restart ? "{\"ok\":true,\"restart\":true}" : "{\"ok\":true}");
  if (restart) xTaskCreate(restart_task, "labs_rst", 2048, NULL, 3, NULL);
  return ESP_OK;
}

void labs_web_rename(const char *host) {
  mdns_hostname_set(host);
}

void labs_web_start(const char *host) {
  if (s_srv) return;
  if (mdns_init() == ESP_OK) {
    mdns_hostname_set(host);
    mdns_instance_name_set("Open Lounge Phone labs");
    mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
  }
  httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
  cfg.ctrl_port = 32770;          // the setup network's page has its own server
  cfg.stack_size = 8192;
  if (httpd_start(&s_srv, &cfg) != ESP_OK) {
    ESP_LOGW(TAG, "settings page: port 80 busy (setup network open?)");
    s_srv = NULL;
    return;
  }
  httpd_uri_t uris[] = {
      {.uri = "/", .method = HTTP_GET, .handler = h_page},
      {.uri = "/api/login", .method = HTTP_POST, .handler = h_login},
      {.uri = "/api/config", .method = HTTP_GET, .handler = h_get},
      {.uri = "/api/config", .method = HTTP_POST, .handler = h_post},
  };
  for (size_t i = 0; i < sizeof uris / sizeof uris[0]; i++) httpd_register_uri_handler(s_srv, &uris[i]);
  ESP_LOGI(TAG, "settings page: http://%s.local", host);
}
