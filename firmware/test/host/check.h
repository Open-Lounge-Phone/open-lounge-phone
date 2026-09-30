// A tiny test framework: CHECK(cond) records a failure and keeps going; TEST(name) registers.
#pragma once
#include <math.h>
#include <stdio.h>
#include <string.h>

extern int g_failures, g_checks;

#define CHECK(cond)                                                               \
  do {                                                                            \
    g_checks++;                                                                   \
    if (!(cond)) {                                                                \
      g_failures++;                                                               \
      fprintf(stderr, "  FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);           \
    }                                                                             \
  } while (0)
#define CHECK_STR(a, b) CHECK(strcmp((a), (b)) == 0)
#define CHECK_NEAR(a, b, tol) CHECK(fabs((double)(a) - (double)(b)) <= (tol))

typedef void (*test_fn)(void);
void register_test(const char *name, test_fn fn);
#define TEST(name)                                                                 \
  static void name(void);                                                          \
  __attribute__((constructor)) static void reg_##name(void) { register_test(#name, name); } \
  static void name(void)
