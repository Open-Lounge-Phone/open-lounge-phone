import { useEffect, useRef } from "react";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      remove(id: string): void;
      reset(id: string): void;
    };
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
  return new Promise((resolve, reject) => {
    const s = existing ?? document.createElement("script");
    s.addEventListener("load", () => resolve());
    s.addEventListener("error", () => reject(new Error("couldn't load the check")));
    if (!existing) {
      s.src = SCRIPT;
      s.async = true;
      document.head.appendChild(s);
    }
  });
}

/**
 * Cloudflare Turnstile ("are you a person?"), shown on sign-up only when the server has keys.
 * `onToken` gets the response to send with the sign-up (undefined when it expires). Each
 * response works once: change `reset` after every sign-up try to get a fresh one.
 */
export function Turnstile({
  siteKey,
  onToken,
  onFail,
  reset = 0,
}: {
  siteKey: string;
  onToken(token: string | undefined): void;
  /** The check couldn't load or run (blocked script, network, misconfigured key). */
  onFail?(): void;
  /** Bump to run the check again (the last answer was used). */
  reset?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string>(undefined);
  useEffect(() => {
    if (reset === 0 || !widget.current) return;
    onToken(undefined);
    window.turnstile?.reset(widget.current);
  }, [reset, onToken]);
  useEffect(() => {
    let id: string | undefined;
    let gone = false;
    loadScript().then(
      () => {
        if (gone || !box.current || !window.turnstile) return;
        id = window.turnstile.render(box.current, {
          sitekey: siteKey,
          callback: (t: string) => onToken(t),
          "expired-callback": () => onToken(undefined),
          "error-callback": () => {
            onToken(undefined);
            onFail?.();
          },
        });
        widget.current = id;
      },
      () => {
        onToken(undefined);
        onFail?.();
      },
    );
    return () => {
      gone = true;
      widget.current = undefined;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, onToken, onFail]);
  return <div ref={box} className="turnstile" />;
}
