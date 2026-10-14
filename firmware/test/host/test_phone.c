// The firmware's deviceStep (phone.c): the call actions, mirroring packages/core device.test.ts.
#include <stdlib.h>

#include "cJSON.h"
#include "check.h"
#include "phone.h"

static char s_sent[8][160];
static int s_n;

static void emit(cJSON *m) {
  char *t = cJSON_PrintUnformatted(m);
  if (s_n < 8) snprintf(s_sent[s_n++], sizeof s_sent[0], "%s", t);
  free(t);
  cJSON_Delete(m);
}

static void server(phone_state_t *s, const char *json) {
  cJSON *m = cJSON_Parse(json);
  phone_server(s, m, emit);
  cJSON_Delete(m);
}

/** A connected call c1 with the handset up. */
static void in_call(phone_state_t *s) {
  phone_init(s);
  phone_hook(s, true, emit);
  phone_button(s, 0, emit);
  server(s, "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"active\"}");
  s_n = 0;
}

TEST(phone_hold_add_merge) {
  phone_state_t s;
  in_call(&s);
  phone_action_t a[2];
  CHECK(phone_actions(&s, a) == 2 && a[0] == ACT_HOLD && a[1] == ACT_TRANSFER);
  phone_action(&s, ACT_HOLD, emit);
  CHECK(s.kind == PH_OFFHOOK);
  CHECK_STR(s.held, "c1");
  CHECK_STR(s_sent[0], "{\"t\":\"call.hold\",\"callId\":\"c1\",\"hold\":true}");
  CHECK(phone_actions(&s, a) == 1 && a[0] == ACT_RESUME);
  phone_button(&s, 2, emit);  // add a caller
  CHECK(s.kind == PH_DIALING);
  CHECK_STR(s.held, "c1");
  server(&s, "{\"t\":\"call.state\",\"callId\":\"c2\",\"state\":\"active\"}");
  CHECK(s.kind == PH_INCALL && s.connected);
  CHECK_STR(s.held, "c1");
  CHECK(phone_actions(&s, a) == 2 && a[0] == ACT_MERGE);
  s_n = 0;
  phone_action(&s, ACT_MERGE, emit);
  CHECK(s.kind == PH_INROOM && !s.room_id[0]);
  CHECK_STR(s_sent[0], "{\"t\":\"call.merge\",\"callId\":\"c1\",\"with\":\"c2\"}");
}

TEST(phone_resume_and_held_hangs_up) {
  phone_state_t s;
  in_call(&s);
  phone_action(&s, ACT_HOLD, emit);
  phone_action(&s, ACT_RESUME, emit);
  CHECK(s.kind == PH_INCALL && s.connected && !s.held[0]);
  CHECK_STR(s_sent[1], "{\"t\":\"call.hold\",\"callId\":\"c1\",\"hold\":false}");
  phone_action(&s, ACT_HOLD, emit);
  server(&s, "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ended\",\"reason\":\"hangup\"}");
  CHECK(s.kind == PH_OFFHOOK && !s.held[0]);
  CHECK_STR(s.last_end, "hangup");
}

TEST(phone_hook_down_hangs_up_held) {
  phone_state_t s;
  in_call(&s);
  phone_action(&s, ACT_HOLD, emit);
  phone_button(&s, 3, emit);
  s_n = 0;
  phone_hook(&s, false, emit);
  CHECK(s.kind == PH_IDLE);
  CHECK(s_n == 2);
  CHECK_STR(s_sent[0], "{\"t\":\"call.hangup\",\"callId\":\"c1\"}");
}

TEST(phone_transfer_blind_and_attended) {
  phone_state_t s;
  in_call(&s);
  phone_action(&s, ACT_TRANSFER, emit);
  CHECK(s.transfer_pending && s_n == 0);
  phone_button(&s, 4, emit);
  CHECK(!s.transfer_pending);
  CHECK_STR(s_sent[0], "{\"t\":\"call.transfer\",\"callId\":\"c1\",\"to\":{\"button\":4}}");
  in_call(&s);
  phone_action(&s, ACT_HOLD, emit);
  phone_button(&s, 1, emit);
  server(&s, "{\"t\":\"call.state\",\"callId\":\"c2\",\"state\":\"active\"}");
  s_n = 0;
  phone_action(&s, ACT_TRANSFER, emit);
  CHECK_STR(s_sent[0], "{\"t\":\"call.transfer\",\"callId\":\"c1\",\"toCall\":\"c2\"}");
}

TEST(phone_room_mute_and_no_actions) {
  phone_state_t s;
  phone_init(&s);
  phone_action_t a[2];
  CHECK(phone_actions(&s, a) == 0);
  phone_action(&s, ACT_HOLD, emit);  // not offered: nothing
  CHECK(s.kind == PH_IDLE);
  s.kind = PH_INROOM;
  snprintf(s.room_id, sizeof s.room_id, "r1");
  CHECK(phone_actions(&s, a) == 1 && a[0] == ACT_MUTE);
  s_n = 0;
  phone_action(&s, ACT_MUTE, emit);
  CHECK(s.muted);
  CHECK_STR(s_sent[0], "{\"t\":\"room.mute\",\"roomId\":\"r1\",\"muted\":true}");
  in_call(&s);
  s.held_by_them = true;
  CHECK(phone_actions(&s, a) == 0);
}

TEST(phone_voicemail_offer_keeps_ticket) {
  phone_state_t s;
  phone_init(&s);
  phone_hook(&s, true, emit);
  phone_button(&s, 0, emit);
  server(&s, "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ended\",\"reason\":\"timeout\","
             "\"voicemail\":{\"ticket\":\"tkt_0123456789abcdef\",\"name\":\"Mom\",\"maxMs\":90000}}");
  CHECK(s.kind == PH_VOICEMAIL);
  CHECK_STR(s.vm_ticket, "tkt_0123456789abcdef");
  CHECK(s.vm_max_ms == 90000);
}

TEST(phone_dials_an_extension_only_off_hook) {
  phone_state_t s;
  phone_init(&s);
  s_n = 0;
  phone_extension(&s, "204", emit);
  CHECK(s.kind == PH_IDLE && s_n == 0);
  phone_hook(&s, true, emit);
  s_n = 0;
  phone_extension(&s, "204", emit);
  CHECK(s.kind == PH_DIALING && s.button == -1);
  CHECK_STR(s_sent[0], "{\"t\":\"call.extension\",\"number\":\"204\"}");
  server(&s, "{\"t\":\"call.state\",\"callId\":\"c9\",\"state\":\"active\"}");
  CHECK(s.kind == PH_INCALL && s.connected);
}

TEST(phone_transfers_to_an_extension) {
  phone_state_t s;
  in_call(&s);
  phone_transfer_extension(&s, "204", emit);
  CHECK_STR(s_sent[0], "{\"t\":\"call.transfer\",\"callId\":\"c1\",\"to\":{\"extension\":\"204\"}}");
  in_call(&s);
  phone_action(&s, ACT_HOLD, emit);
  s_n = 0;
  phone_transfer_extension(&s, "204", emit);  // not in a call (on hold): nothing
  CHECK(s_n == 0);
}

TEST(phone_waits_in_a_public_lines_queue) {
  phone_state_t s;
  phone_init(&s);
  phone_hook(&s, true, emit);
  phone_button(&s, 3, emit);
  server(&s,
         "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ringing\","
         "\"queue\":{\"position\":2,\"size\":3,\"voicemail\":true}}");
  CHECK(s.kind == PH_DIALING && s.queued && s.queue_pos == 2 && s.queue_size == 3 && s.queue_vm);
  s_n = 0;
  phone_button(&s, 0, emit);  // key 1: leave a voicemail instead
  CHECK(s_n == 1);
  CHECK_STR(s_sent[0], "{\"t\":\"call.voicemail\",\"callId\":\"c1\"}");
  CHECK(s.kind == PH_DIALING);
  // Ringing again (no queue): key 1 does nothing.
  server(&s, "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ringing\"}");
  CHECK(!s.queued && !s.queue_vm);
  s_n = 0;
  phone_button(&s, 0, emit);
  CHECK(s_n == 0);
  // A line that offers no voicemail: key 1 does nothing either.
  server(&s,
         "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ringing\","
         "\"queue\":{\"position\":1,\"size\":1}}");
  CHECK(s.queued && !s.queue_vm);
  phone_button(&s, 0, emit);
  CHECK(s_n == 0);
}

TEST(phone_asks_a_line_to_call_back) {
  phone_state_t s;
  phone_init(&s);
  phone_hook(&s, true, emit);
  phone_button(&s, 3, emit);
  server(&s,
         "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ringing\","
         "\"queue\":{\"position\":2,\"voicemail\":true,\"callback\":true}}");
  CHECK(s.queued && s.queue_cb && s.queue_vm);
  s_n = 0;
  phone_button(&s, 1, emit);  // key 2: call me back
  CHECK(s_n == 1);
  CHECK_STR(s_sent[0], "{\"t\":\"call.callback\",\"callId\":\"c1\"}");
  server(&s,
         "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ended\",\"reason\":"
         "\"hangup\",\"callback\":{\"until\":5}}");
  CHECK(s.kind == PH_OFFHOOK && s.callback);
  phone_hook(&s, false, emit);
  // Later the line calls back; lifting answers and follows into the new call to the line.
  server(&s,
         "{\"t\":\"call.ringing\",\"callId\":\"c1\",\"from\":{\"label\":\"Support\"},"
         "\"callback\":{\"name\":\"Support\"}}");
  CHECK(s.kind == PH_INCOMING && s.callback);
  s_n = 0;
  phone_hook(&s, true, emit);
  CHECK(s.kind == PH_INCALL);
  server(&s,
         "{\"t\":\"call.state\",\"callId\":\"c1\",\"state\":\"ended\",\"reason\":"
         "\"hangup\",\"transfer\":{\"callId\":\"c2\",\"ringing\":true,\"offerer\":true}}");
  CHECK(s.kind == PH_DIALING);
  CHECK_STR(s.call_id, "c2");
  // A line that doesn't offer it: key 2 does nothing.
  server(&s,
         "{\"t\":\"call.state\",\"callId\":\"c2\",\"state\":\"ringing\","
         "\"queue\":{\"position\":1}}");
  s_n = 0;
  phone_button(&s, 1, emit);
  CHECK(s_n == 0);
}
