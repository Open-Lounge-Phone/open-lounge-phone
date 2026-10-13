// strip.c (statusLines): the ready screen's clock.
#include "check.h"
#include "strip.h"

TEST(strip_ready_clock) {
  phone_state_t ph;
  phone_init(&ph);
  phone_config_t cfg = {.present = true};
  strip_input_t in = {.connection = CONN_ONLINE, .state = &ph, .config = &cfg,
                      .call_started_ms = -1, .local_minute = -1};
  char out[2][STATUS_WIDTH + 1];
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
  char out[2][STATUS_WIDTH + 1];
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
