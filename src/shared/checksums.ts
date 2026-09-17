// Checksum validators used to tell real identifiers from lookalikes.
// Shared by the service worker, the content script and the MAIN-world tripwire.

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Verhoeff check over every digit in `value` (non-digits are ignored). */
export function verhoeffValid(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length < 2) return false;
  let check = 0;
  for (let i = digits.length - 1, pos = 0; i >= 0; i--, pos++) {
    check = VERHOEFF_D[check][VERHOEFF_P[pos % 8][Number(digits[i])]];
  }
  return check === 0;
}

/** Aadhaar: 12 digits, cannot start with 0 or 1, Verhoeff-valid. */
export function isValidAadhaar(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== 12 || digits[0] === "0" || digits[0] === "1") return false;
  return verhoeffValid(digits);
}

/** Luhn check. Accepts digits separated by spaces or hyphens only. */
export function isLuhnValid(value: string): boolean {
  const compact = value.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(compact)) return false;
  let sum = 0;
  let double = false;
  for (let i = compact.length - 1; i >= 0; i--) {
    let digit = compact.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
