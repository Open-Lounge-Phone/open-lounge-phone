// labs/main/labs_ic.c: the house intercom between phones on one Wi-Fi.
#include <string.h>

#include "check.h"
#include "intercom.h"

/** Delivers every line in `o` to each of the phones (as a broadcast does). */
static void deliver(ic_t **phones, int n, uint32_t from_ip, ic_out_t *o, int64_t now) {
  for (int k = 0; k < o->n; k++)
    for (int i = 0; i < n; i++) {
      ic_out_t reply = {0};
      icom_msg(phones[i], from_ip, o->lines[k], now, &reply);
      if (reply.n) deliver(phones, n, 100 + (uint32_t)i, &reply, now);
    }
  o->n = 0;
}

TEST(ic_room_to_room) {
  ic_t kitchen, kids, garage;
  icom_init(&kitchen, "Kitchen"); icom_init(&kids, "Kid's room"); icom_init(&garage, "Garage");
  ic_t *all[] = {&kitchen, &kids, &garage};
  ic_out_t o = {0};
  icom_hello(&kids, &o); deliver(all, 3, 101, &o, 0);
  icom_hello(&garage, &o); deliver(all, 3, 102, &o, 0);
  CHECK(icom_peer_count(&kitchen, 1000) == 2);
  CHECK(icom_call(&kitchen, "KID'S ROOM", false, 0xabc, 0, &o));
  deliver(all, 3, 100, &o, 0);
  CHECK(kids.st == IC_RINGING && garage.st == IC_IDLE);
  CHECK_STR(kids.peer, "KITCHEN");
  char l[2][41];
  icom_lines(&kids, 0, l);
  CHECK_STR(l[0], "KITCHEN CALLING");
  CHECK_STR(l[1], "LIFT TO ANSWER");
  char rooms[8][25];
  CHECK(icom_rooms(&kitchen, 1000, rooms, 8) == 2);
  CHECK_STR(rooms[0], "KID'S ROOM");
  CHECK_STR(rooms[1], "GARAGE");
  CHECK(icom_rooms(&kitchen, 1000 + IC_PEER_MS, rooms, 8) == 0);
  icom_hook(&kids, true, 10, &o); deliver(all, 3, 101, &o, 10);
  CHECK(kitchen.st == IC_TALK && kids.st == IC_TALK);
  CHECK(kitchen.peer_ip == 101 && kids.peer_ip == 100);
  icom_hook(&kitchen, false, 20, &o); deliver(all, 3, 100, &o, 20);
  CHECK(kitchen.st == IC_IDLE && kids.st == IC_IDLE);
  icom_lines(&kids, 21, l);
  CHECK_STR(l[1], "HUNG UP");
}

TEST(ic_all_rooms_first_lift_wins_and_busy) {
  ic_t a, b, c;
  icom_init(&a, "A"); icom_init(&b, "B"); icom_init(&c, "C");
  ic_t *all[] = {&a, &b, &c};
  ic_out_t o = {0};
  icom_call(&a, "*", false, 7, 0, &o); deliver(all, 3, 100, &o, 0);
  CHECK(b.st == IC_RINGING && c.st == IC_RINGING);
  icom_hook(&c, true, 5, &o); deliver(all, 3, 102, &o, 5);
  CHECK(c.st == IC_TALK && a.st == IC_TALK && b.st == IC_IDLE);   // B stops ringing
  // B calls C, who is talking: busy.
  icom_call(&b, "C", false, 9, 6, &o); deliver(all, 3, 101, &o, 6);
  CHECK(b.st == IC_IDLE);
  char l[2][41];
  icom_lines(&b, 7, l);
  CHECK_STR(l[1], "IS BUSY");
}

/** Delivers the lines in `o` to one phone only (UDP order differs per receiver). */
static void deliver_to(ic_t *p, uint32_t from_ip, ic_out_t *o, int64_t now, ic_out_t *reply) {
  for (int k = 0; k < o->n; k++) icom_msg(p, from_ip, o->lines[k], now, reply);
}

TEST(ic_all_rooms_two_lift_at_once) {
  ic_t a, b, c;
  icom_init(&a, "A"); icom_init(&b, "B"); icom_init(&c, "C");
  ic_t *all[] = {&a, &b, &c};
  ic_out_t o = {0};
  icom_call(&a, "*", false, 7, 0, &o); deliver(all, 3, 100, &o, 0);
  // B and C lift at the same instant: each sends ANSWER before hearing the other's.
  ic_out_t ob = {0}, oc = {0}, back = {0};
  icom_hook(&b, true, 5, &ob);
  icom_hook(&c, true, 5, &oc);
  CHECK(b.st == IC_TALK && c.st == IC_TALK);
  // A hears B first: B has the call. Then C's answer: A tells C it went elsewhere.
  deliver_to(&a, 101, &ob, 5, &back);
  deliver_to(&c, 101, &ob, 5, &back);   // C ignores B's answer (it is talking)
  CHECK(back.n == 0);
  deliver_to(&a, 102, &oc, 5, &back);
  deliver_to(&b, 102, &oc, 5, &back);   // B ignores C's answer too
  CHECK(back.n == 1 && strstr(back.lines[0], "OLP1|TAKEN|00000007|C|B") == back.lines[0]);
  deliver(all, 3, 100, &back, 6);
  CHECK(a.st == IC_TALK && b.st == IC_TALK && c.st == IC_IDLE);
  CHECK(a.peer_ip == 101 && !strcmp(a.peer, "B"));
  char l[2][41];
  CHECK(icom_lines(&c, 7, l) == 2);
  CHECK_STR(l[0], "ANSWERED ELSEWHERE");
  CHECK_STR(l[1], "B");
  // C hangs up (it is idle: says nothing), A and B keep talking.
  icom_hook(&c, false, 8, &o);
  CHECK(o.n == 0);
  // Even a stray BYE from C (sent before the TAKEN arrived) leaves A and B alone.
  icom_msg(&a, 102, "OLP1|BYE|00000007|C", 9, &o);
  icom_msg(&b, 102, "OLP1|BYE|00000007|C", 9, &o);
  CHECK(a.st == IC_TALK && b.st == IC_TALK);
  // Only the caller decides: a TAKEN about someone else changes nothing.
  icom_msg(&b, 100, "OLP1|TAKEN|00000007|C|B", 10, &o);
  CHECK(b.st == IC_TALK);
  icom_hook(&b, false, 11, &o); deliver(all, 3, 101, &o, 11);
  CHECK(a.st == IC_IDLE && b.st == IC_IDLE);
}

TEST(ic_doorbell_rings_on_hook_and_times_out) {
  ic_t door, hall;
  icom_init(&door, "Front door"); icom_init(&hall, "Hall");
  ic_t *all[] = {&door, &hall};
  ic_out_t o = {0};
  CHECK(icom_call(&door, "*", true, 3, 0, &o)); deliver(all, 2, 100, &o, 0);
  CHECK(hall.st == IC_RINGING && hall.door);
  icom_hook(&door, false, 1, &o);                 // the door phone stays down: still ringing
  CHECK(door.st == IC_CALLING && o.n == 0);
  icom_tick(&door, IC_RING_MS + 1, &o); deliver(all, 2, 100, &o, IC_RING_MS + 1);
  CHECK(door.st == IC_IDLE && hall.st == IC_IDLE);
  // A chime: no call, just words on the others.
  icom_chime(&door, "DINNER'S READY", &o); deliver(all, 2, 100, &o, 50000);
  CHECK(hall.chimed && hall.st == IC_IDLE);
  char l[2][41];
  icom_lines(&hall, 50001, l);
  CHECK_STR(l[0], "DINNER'S READY");
  // Junk is ignored.
  icom_msg(&hall, 9, "HELLO", 1, &o);
  icom_msg(&hall, 9, "OLP1|RING|x", 1, &o);
  CHECK(hall.st == IC_IDLE && o.n == 0);
}

TEST(ic_renamed_room_replaces_its_old_name) {
  ic_t hall;
  icom_init(&hall, "Hall");
  ic_out_t o = {0};
  icom_msg(&hall, 7, "OLP1|HELLO|PHONE", 0, &o);
  icom_msg(&hall, 8, "OLP1|HELLO|GARAGE", 0, &o);
  icom_msg(&hall, 7, "OLP1|HELLO|KITCHEN", 10, &o);  // the same phone (address), renamed
  CHECK(icom_peer_count(&hall, 20) == 2);
  int named = 0;
  for (int i = 0; i < IC_PEERS; i++) named += !strcmp(hall.peers[i].name, "PHONE");
  CHECK(named == 0);
}

TEST(ic_busy_in_a_server_call) {
  ic_t a, b;
  icom_init(&a, "A"); icom_init(&b, "B");
  ic_t *all[] = {&a, &b};
  ic_out_t o = {0};
  b.engaged = true;  // B is in a call through the server
  icom_call(&a, "B", false, 5, 0, &o); deliver(all, 2, 100, &o, 0);
  CHECK(b.st == IC_IDLE);
  CHECK(a.st == IC_IDLE);  // told BUSY
  char l[2][41];
  icom_lines(&a, 1, l);
  CHECK_STR(l[1], "IS BUSY");
}
