#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <openssl/crypto.h>
#include <openssl/opensslv.h>
#include <openssl/provider.h>
#include <openssl/ssl.h>

/* CI-only prerequisite evidence. This creates no key, certificate, store or
 * listener, and does not substitute for the selected device behavior tests. */
int main(void)
{
    Dl_info crypto = {0};
    Dl_info ssl = {0};
    OSSL_LIB_CTX *library = NULL;
    OSSL_PROVIDER *provider = NULL;
    SSL_CTX *context = NULL;
    int result = 1;

    if (!dladdr((void *)OpenSSL_version, &crypto) ||
        !dladdr((void *)SSL_CTX_new_ex, &ssl))
        goto cleanup;
    library = OSSL_LIB_CTX_new();
    if (library == NULL)
        goto cleanup;
    provider = OSSL_PROVIDER_load(library, "default");
    if (provider == NULL)
        goto cleanup;
    context = SSL_CTX_new_ex(library, NULL, TLS_method());
    if (context == NULL)
        goto cleanup;
    printf("headerVersion=%s\n", OPENSSL_VERSION_STR);
    printf("runtimeVersion=%s\n", OpenSSL_version(OPENSSL_VERSION));
    printf("cryptoPath=%s\n", crypto.dli_fname);
    printf("sslPath=%s\n", ssl.dli_fname);
    printf("provider=default\ncontext=created\n");
    result = 0;
cleanup:
    SSL_CTX_free(context);
    if (provider != NULL)
        OSSL_PROVIDER_unload(provider);
    OSSL_LIB_CTX_free(library);
    return result;
}
