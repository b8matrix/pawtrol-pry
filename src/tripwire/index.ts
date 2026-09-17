// MAIN-world egress tripwire (all frames, document_start). Wraps fetch, XHR
// and sendBeacon to spot the PAGE'S OWN requests carrying card numbers,
// Aadhaar, PAN or emails, and raises __PRY_TRIPWIRE_ALERT__ for content.ts to
// relay. It observes only; requests are never blocked or modified.
//
// Runs in the page's JS world: no chrome.* APIs, and anything defined here is
// visible to page scripts, so everything stays inside this IIFE.

import { digitsOnly, verhoeffValid } from "../shared/checksums";

type Finding = { found: false } | { found: true; kind: string; sample: string };

declare global {
  interface Window {
    __PRY_TRIPWIRE_INSTALLED__?: boolean;
  }
  interface XMLHttpRequest {
    __pry_url?: string;
    __pry_method?: string;
  }
}

(() => {
  if (window.__PRY_TRIPWIRE_INSTALLED__) return;
  window.__PRY_TRIPWIRE_INSTALLED__ = true;

  function luhnDigits(value: string): boolean {
    const digits = digitsOnly(value);
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = parseInt(digits[i], 10);
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  /** Card-network prefix + length check, to cut Luhn false positives on random digit runs. */
  function plausibleCardNumber(digits: string): boolean {
    const length = digits.length;
    if (length < 13 || length > 19) return false;
    switch (digits[0]) {
      case "4":
        return length === 13 || length === 16 || length === 19;
      case "5":
        return length === 16 && /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(digits);
      case "3":
        return (length === 15 && /^3[47]/.test(digits)) || (length >= 14 && /^(30[0-5]|36|38|39)/.test(digits));
      case "6":
        return length >= 16 && /^(6011|65|64[4-9]|62|60|81|82)/.test(digits);
      default:
        return false;
    }
  }

  const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
  const AADHAAR = /(?<![0-9A-Za-z])\d{4}[ -]?\d{4}[ -]?\d{4}(?![0-9A-Za-z])/g;
  const PAN = /(?<![0-9A-Za-z])[A-Z]{5}[0-9]{4}[A-Z](?![0-9A-Za-z])/g;

  function scan(text: unknown): Finding {
    if (!text || typeof text != "string") return { found: false };

    for (const run of text.match(/(?<![0-9A-Za-z])(?:\d[ -]*?){13,19}(?![0-9A-Za-z])/g) ?? []) {
      const digits = run.replace(/\D/g, "");
      if (plausibleCardNumber(digits) && luhnDigits(digits)) {
        return { found: true, kind: "credit_card", sample: "•••• •••• •••• " + digits.slice(-4) };
      }
    }
    for (const candidate of text.match(AADHAAR) ?? []) {
      if (digitsOnly(candidate).length === 12 && verhoeffValid(candidate)) {
        return { found: true, kind: "aadhaar", sample: "•••• •••• " + candidate.replace(/\D/g, "").slice(-4) };
      }
    }
    const pan = text.match(PAN);
    if (pan) return { found: true, kind: "pan", sample: pan[0].slice(0, 2) + "•••••" + pan[0].slice(-2) };
    const email = text.match(EMAIL);
    if (email) {
      const [user, host] = email[0].split("@");
      return { found: true, kind: "email", sample: user.slice(0, 2) + "•••@" + host };
    }
    return { found: false };
  }

  function alert(url: string, method: string, finding: Extract<Finding, { found: true }>) {
    const detail = { url, method, piiType: finding.kind, sample: finding.sample, timestamp: Date.now() };
    console.warn("[PRY Egress Tripwire] Intercepted " + finding.kind + " in " + method + " request to " + url, detail);
    window.dispatchEvent(new CustomEvent("__PRY_TRIPWIRE_ALERT__", { detail }));
  }

  function check(url: string, method: string, body: unknown) {
    const inUrl = scan(url);
    if (inUrl.found) alert(url, method, inUrl);
    if (body) {
      const inBody = scan(body);
      if (inBody.found) alert(url, method, inBody);
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url = typeof input == "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method?.toUpperCase() || (input instanceof Request ? input.method : "GET");
      let body = "";
      if (init?.body) {
        if (typeof init.body == "string") body = init.body;
        else if (init.body instanceof URLSearchParams) body = init.body.toString();
      }
      check(url, method, body);
    } catch {}
    return originalFetch.apply(this, arguments as unknown as [RequestInfo | URL, RequestInit?]);
  } as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL) {
    this.__pry_url = typeof url == "string" ? url : url.href;
    this.__pry_method = method;
    return originalOpen.apply(this, arguments as unknown as Parameters<typeof originalOpen>);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    try {
      check(this.__pry_url || "unknown", this.__pry_method || "POST", typeof body == "string" ? body : "");
    } catch {}
    return originalSend.apply(this, arguments as unknown as Parameters<typeof originalSend>);
  };

  if (navigator.sendBeacon) {
    const originalBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (this: Navigator, url: string | URL, data?: BodyInit | null) {
      try {
        check(typeof url == "string" ? url : url.href, "BEACON", typeof data == "string" ? data : "");
      } catch {}
      return originalBeacon.apply(this, arguments as unknown as Parameters<typeof originalBeacon>);
    };
  }
})();
