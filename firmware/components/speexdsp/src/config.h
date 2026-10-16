/* SpeexDSP build settings for the phone (and its host tests): floating point (the ESP32-S3 has an
 * FPU), the bundled KISS FFT, no exports. */
#define FLOATING_POINT 1
#define USE_KISS_FFT 1
#define EXPORT
/* Memory and messages go through the phone's code (main/echo.c): the large states in PSRAM, and
 * warnings counted instead of printed. */
#define OVERRIDE_SPEEX_ALLOC
#define OVERRIDE_SPEEX_ALLOC_SCRATCH
#define OVERRIDE_SPEEX_REALLOC
#define OVERRIDE_SPEEX_FREE
#define OVERRIDE_SPEEX_FREE_SCRATCH
#define OVERRIDE_SPEEX_WARNING
#define OVERRIDE_SPEEX_WARNING_INT
#define OVERRIDE_SPEEX_NOTIFY
void *speex_alloc(int size);
void *speex_alloc_scratch(int size);
void *speex_realloc(void *ptr, int size);
void speex_free(void *ptr);
void speex_free_scratch(void *ptr);
void speex_warning(const char *str);
void speex_warning_int(const char *str, int val);
void speex_notify(const char *str);
