export type PageType =
  | "email"
  | "banking"
  | "auth"
  | "ecommerce"
  | "form"
  | "social"
  | "search"
  | "productivity"
  | "government"
  | "other";

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

export function classifyPageType(url: string, title: string, text: string): PageType {
  const haystack = `${url} ${title} ${text}`.toLowerCase();

  if (
    /mail\.google\.com|outlook\.(com|live|office365)|proton(\.me|mail)|yahoo\.com\/mail|icloud\.com\/mail|zoho\.com\/mail|mail\.yahoo\.com/.test(
      haystack,
    ) ||
    (/(^|[\s./])(inbox|compose|sent mail|drafts|spam)([\s/.]|$)/.test(haystack) && /@/.test(haystack))
  ) {
    return "email";
  }

  const bankingScore =
    (haystack.match(/\b(upi|neft|rtgs|net\s?banking|cvv|iban)\b/g)?.length ?? 0) * 3 +
    (haystack.match(
      /\b(credit\s?card|debit\s?card|account\s?(number|no\.?)|bank\s?account|savings\s?account|transaction\s?(history|details)|netbanking)\b/g,
    )?.length ?? 0) *
      2 +
    (haystack.match(/\b(bank|banking|balance|statement|transfer|payment|finance|account)\b/g)?.length ?? 0);
  if (bankingScore >= 3) return "banking";

  if (/(login|signin|sign-in|log in|log-in|2fa|two-factor|otp|forgot password|reset password|change password)/.test(haystack)) {
    return "auth";
  }
  if (/\b(shop|cart|checkout|product|buy now|amazon|flipkart|myntra|ajio)\b/.test(haystack)) return "ecommerce";
  if (/\b(form|survey|quiz)\b/.test(haystack)) return "form";
  if (/\b(feed|timeline|profile|tweet|post|facebook|twitter|instagram|linkedin|reddit)\b/.test(haystack)) return "social";
  if (/\b(search|query|results?|bing|duckduckgo)\b/.test(haystack)) return "search";
  if (/\b(doc|sheet|slide|notion|confluence|wiki|docs\.google)\.?\b/.test(haystack)) return "productivity";
  if (/\b(gov\.in|aadhaar|pan card|passport|tax filing|itr|gst)\b/.test(haystack)) return "government";
  return "other";
}

export type FailureCause =
  | "page_load_error"
  | "timeout"
  | "stale_element"
  | "declined"
  | "wrong_target"
  | "not_found"
  | "generic";

export function classifyFailure(detail: string | undefined): FailureCause {
  if (!detail) return "generic";
  if (/browser error page|navigation failed|dns|err_name|err_connection|err_ssl|err_timedout/i.test(detail)) {
    return "page_load_error";
  }
  if (/did not respond|timed out|timeout/i.test(detail)) return "timeout";
  if (/no element \d+|not found on the current page|page changed|stale/i.test(detail)) return "stale_element";
  if (/declined/i.test(detail)) return "declined";
  if (/not a text field|not a <select>|not handled|unknown tool/i.test(detail)) return "wrong_target";
  if (/no option|not found/i.test(detail)) return "not_found";
  return "generic";
}

/** Guess a detection kind from an OCR leak label such as "Aadhaar number". */
export function kindFromLeakLabel(label: string): "id_number" | "credential" | "api_key" | "pii_text" {
  if (/aadhaar|pan|ssn|passport|ifsc/i.test(label)) return "id_number";
  if (/card|email|phone/i.test(label)) return "credential";
  if (/api key|jwt|github|aws|anthropic|openai|token/i.test(label)) return "api_key";
  return "pii_text";
}
