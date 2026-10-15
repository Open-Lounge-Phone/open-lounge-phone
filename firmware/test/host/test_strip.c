// strip.c (statusLines): the ready screen's clock.
#include "check.h"
#include "strip.h"

TEST(strip_ready_clock) {
  phone_state_t ph;
  phone_init(&ph);
  phone_config_t cfg = {.present = true};
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .config = &cfg,
                      .call_started_ms = -1, .local_minute = -1};
  char out[2][STATUS_MAX + 1];
  CHECK(strip_lines(&in, out) == 1);
  CHECK_STR(out[0], "READY");
  in.local_minute = 14 * 60 + 5;
  strip_lines(&in, out);
  CHECK_STR(out[0], "READY 14:05");
  cfg.quiet = true;
  snprintf(cfg.quiet_until, sizeof cfg.quiet_until, "07:00");
  strip_lines(&in, out);
  CHECK_STR(out[0], "QUIET TIL 07:00");
}

TEST(strip_leave_a_message) {
  phone_state_t ph;
  phone_init(&ph);
  ph.kind = PH_VOICEMAIL;
  snprintf(ph.from, sizeof ph.from, "MOM");
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .call_started_ms = -1,
                      .local_minute = -1, .vm_stage = VM_BEEP};
  char out[2][STATUS_MAX + 1];
  strip_lines(&in, out);
  CHECK_STR(out[0], "LEAVE A MESSAGE");
  CHECK_STR(out[1], "MOM");
  in.vm_stage = VM_RECORDING;
  in.vm_remaining_ms = 102000;
  strip_lines(&in, out);
  CHECK_STR(out[0], "RECORDING 01:42");
  CHECK_STR(out[1], "HANG UP TO SEND");
  phone_init(&ph);  // hung up
  in.vm_stage = VM_SENT;
  CHECK(strip_lines(&in, out) == 1);
  CHECK_STR(out[0], "MESSAGE SENT");
}

TEST(strip_keeps_long_names_whole) {
  phone_state_t ph;
  phone_init(&ph);
  phone_config_t cfg = {.present = true, .missed_count = 1};
  snprintf(cfg.missed[0], sizeof cfg.missed[0], "Claude test phone");
  snprintf(cfg.owner_mode, sizeof cfg.owner_mode, "personal");
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .config = &cfg,
                      .call_started_ms = -1, .local_minute = -1};
  char out[2][STATUS_MAX + 1];
  CHECK(strip_lines(&in, out) == 2);
  CHECK_STR(out[0], "MISSED CALL");
  CHECK_STR(out[1], "CLAUDE TEST PHONE");  // scrolls on screen, not cut to 16
}

TEST(strip_public_line_queue) {
  phone_state_t ph;
  phone_init(&ph);
  ph.kind = PH_DIALING;
  ph.queued = true;
  ph.queue_pos = 2;
  ph.queue_size = 3;
  ph.queue_vm = true;
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .call_started_ms = -1,
                      .local_minute = -1, .active_label = "Help"};
  char out[2][STATUS_MAX + 1];
  CHECK(strip_lines(&in, out) == 2);
  CHECK_STR(out[0], "IN LINE 2");
  CHECK_STR(out[1], "1 VOICEMAIL");
  ph.queue_vm = false;
  strip_lines(&in, out);
  CHECK_STR(out[1], "HELP");
  ph.queue_pos = 0;
  strip_lines(&in, out);
  CHECK_STR(out[0], "WAITING IN LINE");
}

TEST(strip_call_me_back) {
  phone_state_t ph;
  phone_init(&ph);
  ph.kind = PH_DIALING;
  ph.queued = true;
  ph.queue_pos = 3;
  ph.queue_vm = true;
  ph.queue_cb = true;
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .call_started_ms = -1,
                      .local_minute = -1, .active_label = "Help"};
  char out[2][STATUS_MAX + 1];
  strip_lines(&in, out);
  CHECK_STR(out[0], "IN LINE 3");
  CHECK_STR(out[1], "1 VM 2 CALL BACK");
  ph.queue_vm = false;
  strip_lines(&in, out);
  CHECK_STR(out[1], "2 CALL ME BACK");
  phone_init(&ph);
  ph.kind = PH_OFFHOOK;
  ph.callback = true;
  strip_lines(&in, out);
  CHECK_STR(out[0], "PLACE KEPT");
  CHECK_STR(out[1], "WE'LL CALL BACK");
  phone_init(&ph);
  ph.kind = PH_INCOMING;
  ph.callback = true;
  snprintf(ph.from, sizeof ph.from, "Support");
  strip_lines(&in, out);
  CHECK_STR(out[0], "SUPPORT");
  CHECK_STR(out[1], "CALLS YOU BACK");
}

TEST(strip_labels_an_addon_calling) {
  phone_state_t ph;
  phone_init(&ph);
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .call_started_ms = -1,
                      .local_minute = -1};
  char out[2][STATUS_MAX + 1];
  ph.kind = PH_INCOMING;
  ph.addon = true;
  snprintf(ph.from, sizeof ph.from, "seat");
  CHECK(strip_lines(&in, out) == 2);
  CHECK_STR(out[0], "SEAT - ADD-ON");
  CHECK_STR(out[1], "LIFT TO ANSWER");
  snprintf(ph.from, sizeof ph.from, "notes taker");
  strip_lines(&in, out);
  CHECK_STR(out[0], "NOTES TAKER");
  CHECK_STR(out[1], "ADD-ON CALLING");
  char label[STATUS_MAX + 1];
  strip_addon_label(label, "seat");
  CHECK_STR(label, "SEAT - ADD-ON");
  // Anyone else: as before.
  ph.addon = false;
  snprintf(ph.from, sizeof ph.from, "Mom");
  strip_lines(&in, out);
  CHECK_STR(out[0], "MOM CALLING");
}

TEST(strip_names_a_missed_call_back) {
  phone_state_t ph;
  phone_init(&ph);
  phone_config_t cfg = {.present = true, .missed_count = 1};
  snprintf(cfg.missed[0], sizeof cfg.missed[0], "Acme Support");
  cfg.missed_callback[0] = true;
  snprintf(cfg.owner_mode, sizeof cfg.owner_mode, "personal");
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .config = &cfg,
                      .call_started_ms = -1, .local_minute = -1};
  char out[2][STATUS_MAX + 1];
  CHECK(strip_lines(&in, out) == 2);
  CHECK_STR(out[0], "MISSED CALL BACK");
  CHECK_STR(out[1], "ACME SUPPORT");
  // With a voicemail too: counted and cycled like any missed call.
  cfg.missed_count = 2;
  snprintf(cfg.missed[1], sizeof cfg.missed[1], "Mom");
  in.now_ms = 0;
  strip_lines(&in, out);
  CHECK_STR(out[0], "2 MISSED CALLS");
  CHECK_STR(out[1], "ACME SUPPORT");
}

TEST(strip_free_lounge_phone_says_sign_in) {
  phone_state_t ph;
  phone_init(&ph);
  ph.kind = PH_OFFHOOK;
  snprintf(ph.last_end, sizeof ph.last_end, "denied");
  ph.sign_in = true;
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .call_started_ms = -1,
                      .local_minute = -1};
  char out[2][STATUS_MAX + 1];
  CHECK(strip_lines(&in, out) == 2);
  CHECK_STR(out[0], "SIGN IN TO CALL");
  CHECK_STR(out[1], "PRESS A KEY");
  ph.sign_in = false;
  strip_lines(&in, out);
  CHECK_STR(out[0], "NOT ALLOWED");
}

TEST(strip_says_muted_in_a_call) {
  phone_state_t ph;
  phone_init(&ph);
  ph.kind = PH_INCALL;
  ph.connected = true;
  snprintf(ph.call_id, sizeof ph.call_id, "c1");
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .active_label = "Ben",
                      .call_started_ms = 0, .now_ms = 65000, .local_minute = -1};
  char out[2][STATUS_MAX + 1];
  strip_lines(&in, out);
  CHECK_STR(out[0], "IN CALL 01:05");
  ph.muted = true;
  strip_lines(&in, out);
  CHECK_STR(out[0], "MUTED 01:05");
  CHECK_STR(out[1], "BEN");
  ph.recorded = true;
  strip_lines(&in, out);
  CHECK_STR(out[0], "REC MUTED 01:05");
  // Every third turn of 3 s the second line says how to unmute (or to mute).
  in.now_ms = 6000;
  strip_lines(&in, out);
  CHECK_STR(out[1], "MENU 3: UNMUTE");
  ph.muted = false;
  ph.recorded = false;
  strip_lines(&in, out);
  CHECK_STR(out[0], "IN CALL 00:06");
  CHECK_STR(out[1], "MENU 3: MUTE");
}

TEST(strip_ringing_says_back_silences) {
  phone_state_t ph;
  phone_init(&ph);
  ph.kind = PH_INCOMING;
  snprintf(ph.from, sizeof ph.from, "Mom");
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .call_started_ms = -1,
                      .local_minute = -1, .now_ms = 0};
  char out[2][STATUS_MAX + 1];
  strip_lines(&in, out);
  CHECK_STR(out[0], "MOM CALLING");
  CHECK_STR(out[1], "LIFT TO ANSWER");
  in.now_ms = 6000;
  strip_lines(&in, out);
  CHECK_STR(out[1], "BACK: SILENCE");
  ph.silenced = true;
  strip_lines(&in, out);
  CHECK_STR(out[1], "LIFT TO ANSWER");
}

TEST(strip_reconnecting_and_connection_lost) {
  phone_state_t ph;
  phone_init(&ph);
  ph.kind = PH_INCALL;
  ph.connected = true;
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .active_label = "Ben",
                      .call_started_ms = 0, .now_ms = 65000, .local_minute = -1,
                      .reconnecting = true};
  char out[2][STATUS_MAX + 1];
  strip_lines(&in, out);
  CHECK_STR(out[0], "RECONNECTING");
  CHECK_STR(out[1], "BEN");
  phone_init(&ph);
  ph.kind = PH_OFFHOOK;
  ph.lost = true;
  snprintf(ph.last_end, sizeof ph.last_end, "error");
  in.reconnecting = false;
  strip_lines(&in, out);
  CHECK_STR(out[0], "CONNECTION LOST");
  CHECK_STR(out[1], "PRESS A KEY");
}

TEST(strip_one_missed_call_points_at_menu_5) {
  phone_state_t ph;
  phone_init(&ph);
  phone_config_t cfg = {.present = true, .missed_count = 1};
  snprintf(cfg.missed[0], sizeof cfg.missed[0], "Mom");
  snprintf(cfg.owner_mode, sizeof cfg.owner_mode, "kids");
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .config = &cfg,
                      .call_started_ms = -1, .local_minute = -1};
  char out[2][STATUS_MAX + 1];
  strip_lines(&in, out);
  CHECK_STR(out[0], "MISSED MOM");
  CHECK_STR(out[1], "ASK A GROWN-UP");  // a message
  cfg.missed_call[0] = true;           // a call that rang, no message
  strip_lines(&in, out);
  CHECK_STR(out[1], "MENU 5: MISSED");
}
