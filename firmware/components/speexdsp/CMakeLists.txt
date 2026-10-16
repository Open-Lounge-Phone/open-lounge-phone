# SpeexDSP 1.2.1 (Xiph.org, BSD-3-Clause, see COPYING): its acoustic echo canceller (mdf.c) and
# the preprocessor's residual echo suppressor (preprocess.c), unmodified, for the phone's echo
# removal (docs/audio.md item 5). Floating point with the bundled KISS FFT (src/config.h).
idf_component_register(
  SRCS "src/mdf.c" "src/preprocess.c" "src/filterbank.c" "src/fftwrap.c" "src/kiss_fft.c" "src/kiss_fftr.c"
  INCLUDE_DIRS "include"
  PRIV_INCLUDE_DIRS "src")
target_compile_definitions(${COMPONENT_LIB} PRIVATE HAVE_CONFIG_H)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-unused-variable -Wno-unused-but-set-variable
                       -Wno-maybe-uninitialized -Wno-shift-negative-value)
