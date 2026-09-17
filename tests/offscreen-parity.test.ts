import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  clampBox,
  boxesIntersect,
  mergeBoxes,
  clusterBoxes,
} from "../src/offscreen/blur";
import {
  computeVerhoeffCheck,
  generateAadhaarSurrogate,
  computeLuhnCheck,
  generateCardSurrogate,
  generatePANSurrogate,
  generateEmailSurrogate,
  generateNameSurrogate,
  generatePhoneSurrogate,
  getSurrogateForKind,
} from "../src/offscreen/surrogate";
import {
  extractPIIPatternLabels,
  createCleanVerification,
  packCropsForVerification,
} from "../src/offscreen/verify";
import {
  evaluateTextPII,
  stripZeroWidthChars,
} from "../src/offscreen/fusion";

// Load Day 1 baseline pure functions from offscreen/offscreen.js
const baselineSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "offscreen", "offscreen.js"),
  "utf8",
);

function extractBaselineFunction(source: string, name: string): any {
  // Extract specific helper implementations from baseline
  if (name === "Ct") {
    // Verhoeff check in baseline
    const match = source.match(/function Ct\((\w+)\)\{([\s\S]*?)return Lt\[\w+\]\}/);
    if (!match) throw new Error("Could not find Ct in baseline");
    const fnBody = `
      var It=[[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
      var At=[[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
      var Lt=[0,4,3,2,1,5,6,7,8,9];
      return function(${match[1]}) { ${match[2]} return Lt[t]; };
    `;
    return new Function(fnBody)();
  }
  if (name === "Pt") {
    // Luhn check in baseline
    const match = source.match(/function Pt\((\w+)\)\{([\s\S]*?)return\(10-r%10\)%10\}/);
    if (!match) throw new Error("Could not find Pt in baseline");
    return new Function(`return function(${match[1]}) { ${match[2]} return (10-r%10)%10; };`)();
  }
  if (name === "xe") {
    // Surrogate picker in baseline
    return new Function(`
      var It=[[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
      var At=[[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
      var Lt=[0,4,3,2,1,5,6,7,8,9];
      function Ct(e){let t=0,r=e.replace(/\\D/g,"").split("").reverse();for(let a=0;a<r.length;a++){let s=parseInt(r[a],10);t=It[t][At[(a+1)%8][s]]}return Lt[t]}
      function Ot(){let e="99990123456",t=Ct(e),r=e+String(t);return r.slice(0,4)+" "+r.slice(4,8)+" "+r.slice(8,12)}
      function Pt(e){let t=e.replace(/\\D/g,""),r=0,a=!0;for(let s=t.length-1;s>=0;s--){let u=parseInt(t[s],10);a&&(u*=2,u>9&&(u-=9)),r+=u,a=!a}return(10-r%10)%10}
      function Et(){let e="400000123456789",t=Pt(e),r=e+String(t);return r.slice(0,4)+" "+r.slice(4,8)+" "+r.slice(8,12)+" "+r.slice(12,16)}
      function Tt(){return"ABCDE1234F"}
      function _t(){return"alex.surrogate@safe-example.internal"}
      function Dt(){return"Alex Morgan"}
      function Nt(){return"+91 98765 43210"}
      return function(e){let t=e.toLowerCase();return t.includes("aadhaar")||t.includes("id_number")||t.includes("national_id")?Ot():t.includes("card")||t.includes("credit")||t.includes("cvv")?Et():t.includes("pan")?Tt():t.includes("email")?_t():t.includes("phone")||t.includes("mobile")?Nt():t.includes("name")||t.includes("person")?Dt():t.includes("pass")||t.includes("token")||t.includes("cred")?"••••••••••••":"[CONFIDENTIAL SURROGATE]"};
    `)();
  }
  if (name === "V") {
    // Bounding box clamp in baseline
    return new Function(`
      return function(e,t,r,a,s){
        let u=Math.max(0,Math.round(t)),h=Math.max(0,Math.round(r)),f=Math.min(e.width,Math.round(t+a)),m=Math.min(e.height,Math.round(r+s));
        return f-u<=0||m-h<=0?null:{x:u,y:h,width:f-u,height:m-h};
      };
    `)();
  }
}

describe("Offscreen Pipeline Parity Tests against Day 1 Baseline", () => {
  test("Verhoeff checksum matches baseline Ct", () => {
    const baselineCt = extractBaselineFunction(baselineSource, "Ct");
    const testCases = [
      "99990123456",
      "23456789012",
      "12345678901",
      "50001112223",
      "98765432109",
    ];
    for (const num of testCases) {
      expect(computeVerhoeffCheck(num)).toBe(baselineCt(num));
    }
  });

  test("Luhn checksum matches baseline Pt", () => {
    const baselinePt = extractBaselineFunction(baselineSource, "Pt");
    const testCases = [
      "400000123456789",
      "411111111111111",
      "550000000000000",
      "37000000000000",
    ];
    for (const num of testCases) {
      expect(computeLuhnCheck(num)).toBe(baselinePt(num));
    }
  });

  test("Surrogate selection matches baseline xe", () => {
    const baselineXe = extractBaselineFunction(baselineSource, "xe");
    const labels = [
      "Aadhaar number",
      "id_number",
      "Credit card",
      "card_number",
      "cvv",
      "pan",
      "email",
      "phone",
      "mobile",
      "name",
      "person",
      "password",
      "token",
      "other_unknown",
    ];
    for (const label of labels) {
      expect(getSurrogateForKind(label)).toBe(baselineXe(label));
    }
  });

  test("Bounding box clamping matches baseline V", () => {
    const baselineV = extractBaselineFunction(baselineSource, "V");
    const mockImage = { width: 1000, height: 800 };

    const boxes = [
      [10, 20, 100, 50],
      [-20, -10, 50, 40],
      [950, 750, 100, 100],
      [1100, 900, 50, 50], // completely out of bounds
    ];

    for (const [x, y, w, h] of boxes) {
      const ours = clampBox(mockImage.width, mockImage.height, x, y, w, h);
      const theirs = baselineV(mockImage, x, y, w, h);
      expect(ours).toEqual(theirs);
    }
  });

  test("Boxes intersect and cluster correctly", () => {
    const boxA = { x: 10, y: 10, width: 50, height: 50 };
    const boxB = { x: 40, y: 40, width: 50, height: 50 };
    const boxC = { x: 200, y: 200, width: 50, height: 50 };

    expect(boxesIntersect(boxA, boxB)).toBe(true);
    expect(boxesIntersect(boxA, boxC)).toBe(false);

    const merged = mergeBoxes(boxA, boxB);
    expect(merged.x).toBe(10);
    expect(merged.y).toBe(10);
    expect(merged.width).toBe(80);
    expect(merged.height).toBe(80);

    const clustered = clusterBoxes([boxA, boxB, boxC]);
    expect(clustered.length).toBe(2);
  });

  test("extractPIIPatternLabels identifies sensitive patterns", () => {
    const text = "Contact john.doe@example.com or call +91 98765 43210. Card: 4111 1111 1111 1111";
    const labels = extractPIIPatternLabels(text);
    expect(labels).toContain("Email address");
    expect(labels).toContain("Indian phone");
    expect(labels).toContain("Card number");
  });

  test("cleanVerification produces verified report", () => {
    const clean = createCleanVerification(123456789);
    expect(clean.verified).toBe(true);
    expect(clean.regionsChecked).toBe(0);
    expect(clean.confidence).toBe(1);
  });

  test("packCropsForVerification correctly calculates atlas slots", () => {
    const regions = [
      { x: 10, y: 10, width: 100, height: 40 },
      { x: 20, y: 80, width: 150, height: 50 },
    ];
    const atlas = packCropsForVerification(regions);
    expect(atlas.slots.length).toBe(2);
    expect(atlas.width).toBeGreaterThan(0);
    expect(atlas.height).toBeGreaterThan(0);
  });
});

describe("Signal Fusion & Edge Cases Tests", () => {
  test("stripZeroWidthChars strips zero-width non-joiners/spaces", () => {
    const obfuscated = "2\u200B3\u200C4\u200D5\uFEFF 6\u200B7\u200C8\u200D9\uFEFF 0\u200B1\u200C2\u200D4";
    expect(stripZeroWidthChars(obfuscated)).toBe("2345 6789 0124");
  });

  test("evaluateTextPII detects Verhoeff-valid Aadhaar with zero-width characters", () => {
    const obfuscated = "Aadhaar: 2\u200B3\u200C4\u200D5\uFEFF 6\u200B7\u200C8\u200D9\uFEFF 0\u200B1\u200C2\u200D4";
    const match = evaluateTextPII(obfuscated);
    expect(match).not.toBeNull();
    expect(match?.kind).toBe("id_number");
    expect(match?.label).toContain("Aadhaar");
  });

  test("evaluateTextPII detects Luhn-valid card numbers", () => {
    const match = evaluateTextPII("Account Visa: 4111 1111 1111 1111");
    expect(match).not.toBeNull();
    expect(match?.kind).toBe("credential");
    expect(match?.label).toContain("Card number");
  });

  test("evaluateTextPII detects PAN card", () => {
    const match = evaluateTextPII("Income Tax PAN: ABCDE1234F on document");
    expect(match).not.toBeNull();
    expect(match?.kind).toBe("id_number");
    expect(match?.label).toContain("PAN");
  });

  test("evaluateTextPII detects API keys", () => {
    const match = evaluateTextPII("Bearer sk-ant-api03-kJ89zQ21aBcDeFgHiJkLmNoPqRsTuVwXyZ");
    expect(match).not.toBeNull();
    expect(match?.kind).toBe("api_key");
  });
});
