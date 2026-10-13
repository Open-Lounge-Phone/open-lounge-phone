// Leaving a voicemail from the phone (docs/phone-ux.md): after an unanswered call the server
// offers a single-use ticket; the earpiece beeps, the handset mic records (8 kHz 16-bit WAV in
// PSRAM, up to the offer's limit), and hanging up sends it to `POST /api/vm/message?ticket=`.
// Recorded greetings aren't played (they are Opus from the app); the beep starts it.
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef enum { VM_IDLE, VM_BEEP, VM_RECORDING, VM_SENDING, VM_SENT, VM_FAILED } vm_stage_t;

#define VM_MIN_MS 1500        // shorter than this (a quick hang-up) is not sent
#define VM_RESULT_SHOW_MS 4000

/** The handset is up in the voicemail state: beep, then record. */
void vm_leave_start(const char *ticket, int max_ms, int64_t now_ms);
/** Hung up: send what was recorded (or drop it if too short). */
void vm_leave_finish(int64_t now_ms);
/** The upload finished (EV_VM_SENT, from the upload task). */
void vm_leave_sent(bool ok, int64_t now_ms);
void vm_leave_tick(int64_t now_ms);
vm_stage_t vm_leave_stage(void);
/** While recording: ms left before the limit. */
int vm_leave_remaining_ms(int64_t now_ms);
const char *vm_stage_name(vm_stage_t s);
