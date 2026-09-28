"""Main <-> deck 24-pin 0.5 mm FFC pinout (single source for both boards).

DESIGN.md §5 lists 3V3 x2, VSYS x2, GND x6, EPD x6, I2C x2, IRQ, LED_DATA, MICBIAS_IN,
MICBIAS_OUT, PRIV_LED_K and "spare x2" - that is 25 signals for a 24-pin cable, so one spare
is dropped (see SCHEMATIC.md "Deviations").

Since the stacked form factor (owner decision 2026-09-27) VOL-/VOL+/MUTE sit on the MAIN
board edge: the MUTE switch breaks the mic bias locally on the main board, so the two mic-bias
pins and the spare now carry MUTE_SENSE, VOL_DN and VOL_UP to the AW9523B on the deck.

Ordering rules used here:
- the fast edges (EPD_SCK, LED_DATA) each sit between GND pins;
- the slow side-switch lines sit at the far end, fenced by GND;
- power pins are paired for current (VSYS carries up to ~0.4 A of LED current).

Pin n on the main connector is pin n on the deck connector. Choose the FFC type (same-side vs
opposite-side contacts) at layout time so that this holds for the chosen connector orientation.
"""

FFC_PINS = {
    1: "VSYS",
    2: "VSYS",
    3: "GND",
    4: "LED_DATA_BUF",  # buffered (SN74LV1T125 on main, VSYS level)
    5: "GND",
    6: "3V3",
    7: "3V3",
    8: "EPD_BUSY",
    9: "EPD_RST",
    10: "EPD_DC",
    11: "GND",
    12: "EPD_SCK",
    13: "GND",
    14: "EPD_MOSI",
    15: "EPD_CS",
    16: "I2C_SCL",
    17: "I2C_SDA",
    18: "IRQ",
    19: "PRIV_LED_K",
    20: "MUTE_SENSE",
    21: "GND",
    22: "VOL_DN",
    23: "VOL_UP",
    24: "GND",
}
