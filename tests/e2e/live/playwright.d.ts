// playwright-core is not a dependency of this repo; the live test loads it from
// $PLAYWRIGHT_CORE (any local install whose Chromium is downloaded). Loosely typed on purpose.
declare module "playwright-core" {
  // biome-ignore lint/suspicious/noExplicitAny: an optional, untyped dependency
  type Loose = any;
  export type Browser = Loose;
  export type BrowserContext = Loose;
  export type CDPSession = Loose;
  export type Page = Loose;
  export const chromium: Loose;
}
