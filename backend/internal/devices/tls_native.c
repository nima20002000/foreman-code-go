//go:build cgo

#include "tls_native.h"

#include <limits.h>
#include <stdio.h>
#include <openssl/bio.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/pemerr.h>
#include <openssl/provider.h>
#include <openssl/ssl.h>
#include <openssl/sslerr.h>
#include <openssl/x509v3.h>

/* An explicit empty password preserves the frozen callbacks, including keys
 * encrypted with an empty passphrase. A NULL callback could prompt for input. */
static int device_tls_no_password(char *buffer, int size, int writing, void *data)
{
    (void)buffer;
    (void)size;
    (void)writing;
    (void)data;
    return 0;
}

static BIO *device_tls_input(const unsigned char *bytes, size_t length)
{
    static const unsigned char empty = 0;
    if (length > INT_MAX)
        return NULL;
    return BIO_new_mem_buf(length == 0 ? &empty : bytes, (int)length);
}

static void device_tls_capture_error(device_tls_result *result,
                                      const char *operation)
{
    /* Node's operation error selects the earliest queue entry. The latest
     * entry is inspected separately only for the chain reader's EOF case. */
    unsigned long error = ERR_get_error();
    result->status = DEVICE_TLS_ERROR;
    if (ERR_GET_LIB(error) == ERR_LIB_SSL) {
        switch (ERR_GET_REASON(error)) {
        case SSL_R_EE_KEY_TOO_SMALL:
            result->status = DEVICE_TLS_LEAF_KEY_TOO_SMALL;
            break;
        case SSL_R_CA_KEY_TOO_SMALL:
            result->status = DEVICE_TLS_CHAIN_KEY_TOO_SMALL;
            break;
        case SSL_R_CA_MD_TOO_WEAK:
            result->status = DEVICE_TLS_WEAK_SIGNATURE;
            break;
        }
    }
    if (error != 0 || operation == NULL)
        ERR_error_string_n(error, result->detail, sizeof(result->detail));
    else
        snprintf(result->detail, sizeof(result->detail), "%s", operation);
}

/* The operation sequence follows the frozen Node 22.23.2 X509 parser and
 * secure-context loader. There is no listener, root-store loading, signature
 * verification, public trust adaptation, or device authorization here.
 *
 * The target must provide OpenSSL 3.5.7 and a disposable process environment.
 * In particular, OpenSSL's own startup can consult configuration and key-log
 * environment variables. This core does not alter global settings or env vars.
 */
void device_tls_validate(const unsigned char *certificate, size_t certificate_len,
                         const unsigned char *key, size_t key_len,
                         const unsigned char *hostname, size_t hostname_len,
                         int hostname_is_ip, device_tls_result *result)
{
    OSSL_LIB_CTX *library = NULL;
    OSSL_PROVIDER *provider = NULL;
    SSL_CTX *context = NULL;
    BIO *identity_input = NULL;
    BIO *chain_input = NULL;
    BIO *key_input = NULL;
    X509 *identity = NULL;
    X509 *leaf = NULL;
    X509 *extra = NULL;
    STACK_OF(X509) *chain = NULL;
    EVP_PKEY *private_key = NULL;
    char *ip_hostname = NULL;
    char *peername = NULL;
    const char *operation = "native allocation failed";
    unsigned long error;
    int match;

    result->status = DEVICE_TLS_ERROR;
    result->detail[0] = '\0';
    ERR_clear_error();

    library = OSSL_LIB_CTX_new();
    if (library == NULL)
        goto failed;
    provider = OSSL_PROVIDER_load(library, "default");
    if (provider == NULL)
        goto failed;

    operation = NULL;
    identity_input = device_tls_input(certificate, certificate_len);
    identity = X509_new_ex(library, NULL);
    if (identity_input == NULL || identity == NULL)
        goto failed;
    if (PEM_read_bio_X509_AUX(identity_input, &identity,
                              device_tls_no_password, NULL) == NULL) {
        X509_free(identity);
        identity = X509_new_ex(library, NULL);
        if (identity == NULL)
            goto failed;
        BIO_reset(identity_input);
        if (d2i_X509_bio(identity_input, &identity) == NULL)
            goto failed;
    }
    ERR_clear_error();

    operation = "SSL_CTX_new";
    context = SSL_CTX_new_ex(library, NULL, TLS_method());
    if (context == NULL)
        goto failed;
    /* Node's pinned build defaults to level 1. This affects only this new
     * material-validation context and does not change process-wide policy. */
    SSL_CTX_set_security_level(context, 1);
    if (!SSL_CTX_set_min_proto_version(context, TLS1_2_VERSION))
        goto failed;

    operation = "SSL_CTX_use_certificate_chain";
    ERR_clear_error();
    chain_input = device_tls_input(certificate, certificate_len);
    leaf = X509_new_ex(library, NULL);
    if (chain_input == NULL || leaf == NULL)
        goto failed;
    if (PEM_read_bio_X509_AUX(chain_input, &leaf,
                              device_tls_no_password, NULL) == NULL)
        goto failed;
    chain = sk_X509_new_null();
    if (chain == NULL)
        goto failed;
    for (;;) {
        extra = X509_new_ex(library, NULL);
        if (extra == NULL)
            goto failed;
        if (PEM_read_bio_X509(chain_input, &extra,
                              device_tls_no_password, NULL) == NULL) {
            X509_free(extra);
            extra = NULL;
            break;
        }
        if (!sk_X509_push(chain, extra))
            goto failed;
        extra = NULL; /* The stack now owns our reference. */
    }
    error = ERR_peek_last_error();
    if (ERR_GET_LIB(error) != ERR_LIB_PEM ||
        ERR_GET_REASON(error) != PEM_R_NO_START_LINE)
        goto failed;
    ERR_clear_error();

    if (!SSL_CTX_use_certificate(context, leaf))
        goto failed;
    SSL_CTX_clear_extra_chain_certs(context);
    for (int index = 0; index < sk_X509_num(chain); index++) {
        if (!SSL_CTX_add1_chain_cert(context, sk_X509_value(chain, index)))
            goto failed;
    }
    ERR_clear_error();

    operation = "PEM_read_bio_PrivateKey";
    key_input = device_tls_input(key, key_len);
    if (key_input == NULL)
        goto failed;
    private_key = PEM_read_bio_PrivateKey_ex(key_input, NULL,
                                             device_tls_no_password, NULL,
                                             library, NULL);
    if (private_key == NULL)
        goto failed;
    operation = "SSL_CTX_use_PrivateKey";
    /* This intentionally uses OpenSSL's algorithm slots. A universal
     * SSL_CTX_check_private_key would reject frozen accepted cross-slot input. */
    if (!SSL_CTX_use_PrivateKey(context, private_key))
        goto failed;

    if (hostname_len != 0) {
        ERR_clear_error();
        operation = "advertised hostname check failed";
        if (hostname_is_ip) {
            ip_hostname = OPENSSL_strndup((const char *)hostname, hostname_len);
            if (ip_hostname == NULL)
                goto failed;
            match = X509_check_ip_asc(identity, ip_hostname, 0);
        } else {
            match = X509_check_host(identity, (const char *)hostname,
                                     hostname_len, 0, &peername);
        }
        if (match == 0) {
            result->status = DEVICE_TLS_HOST_MISMATCH;
            goto cleanup;
        }
        if (match != 1) {
            result->status = match == -2
                ? (hostname_is_ip ? DEVICE_TLS_INVALID_IP : DEVICE_TLS_INVALID_HOSTNAME)
                : DEVICE_TLS_HOST_OPERATION_FAILED;
            goto cleanup;
        }
    }
    result->status = DEVICE_TLS_OK;
    goto cleanup;

failed:
    device_tls_capture_error(result, operation);
cleanup:
    OPENSSL_free(peername);
    OPENSSL_free(ip_hostname);
    EVP_PKEY_free(private_key);
    BIO_free(key_input);
    X509_free(extra);
    sk_X509_pop_free(chain, X509_free);
    X509_free(leaf);
    BIO_free(chain_input);
    X509_free(identity);
    BIO_free(identity_input);
    SSL_CTX_free(context);
    if (provider != NULL)
        OSSL_PROVIDER_unload(provider);
    OSSL_LIB_CTX_free(library);
    ERR_clear_error();
}
