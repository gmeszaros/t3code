#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  char resolved[PATH_MAX];
  if (_NSGetExecutablePath(executable, &size) != 0 || realpath(executable, resolved) == NULL) {
    perror("Cannot resolve desktop launcher path");
    return 1;
  }
  char *separator = strrchr(resolved, '/');
  if (separator == NULL) return 1;
  *separator = '\0';
  char script[PATH_MAX];
  int length = snprintf(script, sizeof(script), "%s/../Resources/t3-launcher.sh", resolved);
  if (length < 0 || (size_t)length >= sizeof(script)) {
    fprintf(stderr, "Desktop launcher path is too long\n");
    return 1;
  }
  char **arguments = calloc(argc + 2, sizeof(char *));
  if (arguments == NULL) return 1;
  arguments[0] = "/bin/sh";
  arguments[1] = script;
  for (int index = 1; index < argc; index++) arguments[index + 1] = argv[index];
  execv(arguments[0], arguments);
  perror("Cannot start desktop launcher script");
  free(arguments);
  return 1;
}
