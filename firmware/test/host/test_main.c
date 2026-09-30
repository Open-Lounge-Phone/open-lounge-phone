#include <stdbool.h>
#include <stdlib.h>

#include "check.h"

int g_failures, g_checks;
static struct {
  const char *name;
  test_fn fn;
} s_tests[256];
static int s_n;

void register_test(const char *name, test_fn fn) {
  if (s_n < 256) s_tests[s_n++] = (typeof(s_tests[0])){name, fn};
}

int main(int argc, char **argv) {
  int failed_tests = 0;
  for (int i = 0; i < s_n; i++) {
    if (argc > 1 && !strstr(s_tests[i].name, argv[1])) continue;
    int before = g_failures;
    s_tests[i].fn();
    bool ok = g_failures == before;
    if (!ok) failed_tests++;
    printf("%s %s\n", ok ? "ok  " : "FAIL", s_tests[i].name);
  }
  printf("%d tests, %d checks, %d failed checks\n", s_n, g_checks, g_failures);
  return failed_tests ? 1 : 0;
}
