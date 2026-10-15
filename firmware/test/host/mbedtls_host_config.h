// The host tests' mbedtls: only what lan_crypto.c uses (the same sources the phone builds).
#pragma once
#define MBEDTLS_AES_C
#define MBEDTLS_CIPHER_MODE_CTR
#define MBEDTLS_SHA256_C
