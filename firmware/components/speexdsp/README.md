SpeexDSP 1.2.1 (https://gitlab.xiph.org/xiph/speexdsp, tag SpeexDSP-1.2.1), BSD-3-Clause
(`COPYING`). Only the echo canceller and the preprocessor (with what they need) are here,
unmodified; `include/speex/speexdsp_config_types.h` and `src/config.h` replace upstream's
generated files. The phone uses it through `main/echo.c`.
