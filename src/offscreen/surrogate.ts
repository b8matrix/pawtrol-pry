// Checksum tables for surrogate generation (Verhoeff & Luhn)
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

const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function computeVerhoeffCheck(input: string): number {
  let c = 0;
  const reversed = input.replace(/\D/g, "").split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    const digit = parseInt(reversed[i], 10);
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][digit]];
  }
  return VERHOEFF_INV[c];
}

export function generateAadhaarSurrogate(): string {
  const base = "99990123456";
  const check = computeVerhoeffCheck(base);
  const full = base + String(check);
  return `${full.slice(0, 4)} ${full.slice(4, 8)} ${full.slice(8, 12)}`;
}

export function computeLuhnCheck(input: string): number {
  const clean = input.replace(/\D/g, "");
  let sum = 0;
  let double = true;
  for (let i = clean.length - 1; i >= 0; i--) {
    let digit = parseInt(clean[i], 10);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export function generateCardSurrogate(): string {
  const base = "400000123456789";
  const check = computeLuhnCheck(base);
  const full = base + String(check);
  return `${full.slice(0, 4)} ${full.slice(4, 8)} ${full.slice(8, 12)} ${full.slice(12, 16)}`;
}

export function generatePANSurrogate(): string {
  return "ABCDE1234F";
}

export function generateEmailSurrogate(): string {
  return "alex.surrogate@safe-example.internal";
}

export function generateNameSurrogate(): string {
  return "Alex Morgan";
}

export function generatePhoneSurrogate(): string {
  return "+91 98765 43210";
}

export function getSurrogateForKind(kindOrLabel: string): string {
  const lower = kindOrLabel.toLowerCase();
  if (lower.includes("aadhaar") || lower.includes("id_number") || lower.includes("national_id")) {
    return generateAadhaarSurrogate();
  }
  if (lower.includes("card") || lower.includes("credit") || lower.includes("cvv")) {
    return generateCardSurrogate();
  }
  if (lower.includes("pan")) {
    return generatePANSurrogate();
  }
  if (lower.includes("email")) {
    return generateEmailSurrogate();
  }
  if (lower.includes("phone") || lower.includes("mobile")) {
    return generatePhoneSurrogate();
  }
  if (lower.includes("name") || lower.includes("person")) {
    return generateNameSurrogate();
  }
  if (lower.includes("pass") || lower.includes("token") || lower.includes("cred")) {
    return "••••••••••••";
  }
  return "[CONFIDENTIAL SURROGATE]";
}
