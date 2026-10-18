#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

/* The build supplies fixture_node and fixture_script as unsigned UTF-8 bytes. */
int main(int argc, char **argv)
{
    char **forwarded = calloc((size_t)argc + 2, sizeof(*forwarded));
    if (forwarded == NULL) {
        perror("Allocate isolated Codex arguments");
        return 127;
    }
    forwarded[0] = (char *)fixture_node;
    forwarded[1] = (char *)fixture_script;
    for (int index = 1; index < argc; index++) {
        forwarded[index + 1] = argv[index];
    }
    execv(forwarded[0], forwarded);
    perror("Start isolated Codex fixture");
    free(forwarded);
    return 127;
}
