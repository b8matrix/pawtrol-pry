// Text normalization shared by the content script, worker and offscreen OCR.

/** Zero-width and invisible formatting characters used to split identifiers past regexes. */
const INVISIBLE_CLASS = "\\u200B-\\u200D\\u2060\\uFEFF\\u00AD";
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "g");
const IS_INVISIBLE = new RegExp(`^[${INVISIBLE_CLASS}]$`);

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

export interface NormalizedText {
  text: string;
  /** For each index in `text`, the index of that character in the original string. */
  originalIndex: number[];
}

/**
 * Strip invisible characters while remembering where each kept character came
 * from, so a match in the normalized text can be mapped back to a DOM Range.
 */
export function stripInvisibleWithMap(original: string): NormalizedText {
  let text = "";
  const originalIndex: number[] = [];
  for (let i = 0; i < original.length; i++) {
    if (IS_INVISIBLE.test(original[i])) continue;
    text += original[i];
    originalIndex.push(i);
  }
  return { text, originalIndex };
}

/** Original [start, end) offsets for a match at [start, end) in normalized text. */
export function mapRangeToOriginal(normalized: NormalizedText, start: number, end: number): [number, number] {
  const from = normalized.originalIndex[start];
  const last = normalized.originalIndex[end - 1];
  return [from, last + 1];
}

/**
 * OCR commonly confuses letters and digits. Inside digit-dominated tokens,
 * map lookalike letters to digits so checksum validation sees the real number.
 */
export function normalizeOcrDigits(text: string): string {
  // A group is a run of lookalike-or-digit tokens separated by single spaces or
  // hyphens ("4lll 1111 IIII 1111"); it is converted only if mostly real digits.
  return stripInvisible(text).replace(/[0-9OoIlL|SsBZz]+(?:[ -][0-9OoIlL|SsBZz]+)*/g, (group) => {
    const chars = group.replace(/[ -]/g, "");
    const digits = (chars.match(/\d/g) ?? []).length;
    if (chars.length < 3 || digits < chars.length / 2) return group;
    return group
      .replace(/[Oo]/g, "0")
      .replace(/[IlL|]/g, "1")
      .replace(/[Ss]/g, "5")
      .replace(/B/g, "8")
      .replace(/[Zz]/g, "2");
  });
}
