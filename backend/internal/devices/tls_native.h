#ifndef FOREMAN_DEVICE_TLS_NATIVE_H
#define FOREMAN_DEVICE_TLS_NATIVE_H

#include <stddef.h>

enum device_tls_status {
    DEVICE_TLS_OK = 0,
    DEVICE_TLS_ERROR,
    DEVICE_TLS_HOST_MISMATCH,
    DEVICE_TLS_INVALID_HOSTNAME,
    DEVICE_TLS_INVALID_IP,
    DEVICE_TLS_HOST_OPERATION_FAILED,
    DEVICE_TLS_LEAF_KEY_TOO_SMALL,
    DEVICE_TLS_CHAIN_KEY_TOO_SMALL,
    DEVICE_TLS_WEAK_SIGNATURE
};

typedef struct {
    int status;
    char detail[128];
} device_tls_result;

void device_tls_validate(const unsigned char *certificate, size_t certificate_len,
                         const unsigned char *key, size_t key_len,
                         const unsigned char *hostname, size_t hostname_len,
                         int hostname_is_ip, device_tls_result *result);

#endif
