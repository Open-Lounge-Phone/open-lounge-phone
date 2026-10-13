// labs/main/labs_ic.c: the house intercom between phones on one Wi-Fi.
#include <string.h>

#include "check.h"
#include "labs_ic.h"

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
  CHECK_STR(l[1], "LIFT TO ANSWER");
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
