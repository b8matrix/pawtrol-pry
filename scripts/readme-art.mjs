// Generates the animated SVGs used by README.md, in a light and a dark
// variant each (docs/readme/<name>-<theme>.svg). The README switches between
// them with <picture> and prefers-color-scheme, so they follow the reader's
// GitHub theme. Animations are plain CSS keyframes inside the SVG, which
// GitHub keeps when it shows an SVG as an image.
//
//   node scripts/readme-art.mjs
//
// Colours come from styles.css (the "Run Ledger" design system, DESIGN.md).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs", "readme");

const THEMES = {
  light: {
    bg: "#ffffff", surface: "#fafafa", surface2: "#f4f4f5", line: "#ececef", lineStrong: "#d9d9de",
    ink: "#09090b", ink2: "#3f3f46", mute: "#6b6b74", accent: "#4a6f9a", accentTint: "#eef3f9",
    accentLine: "#c5d4e5", onAccent: "#ffffff", alert: "#b0442a", alertTint: "#fcefea", alertLine: "#efc9bd",
    ok: "#2f6f4f", okTint: "#e9f4ee", okLine: "#bfdcca", cross: "#a1a1aa", grid: "none",
    mask: "#18181b", maskText: "#a1a1aa", face: "#c9d3de", faceShade: "#9fb0c2", glow: 0.16,
  },
  dark: {
    bg: "#0d1117", surface: "#131920", surface2: "#1a212a", line: "#212933", lineStrong: "#2f3945",
    ink: "#e7ecf2", ink2: "#b7c1cc", mute: "#8591a0", accent: "#84aad6", accentTint: "#172334",
    accentLine: "#33506f", onAccent: "#0a121d", alert: "#ec997e", alertTint: "#2b1a15", alertLine: "#5a3226",
    ok: "#82c7a0", okTint: "#14251c", okLine: "#2c5a40", cross: "#5f84ad", grid: "rgba(132,170,214,0.07)",
    mask: "#000000", maskText: "#6b7686", face: "#2a3a4d", faceShade: "#3d5572", glow: 0.22,
  },
};

const DISPLAY = "'Barlow Condensed','Avenir Next Condensed','Roboto Condensed','Arial Narrow','Helvetica Neue',Arial,sans-serif";
const BODY = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono','JetBrains Mono','Cascadia Mono',Menlo,Consolas,monospace";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Rough text widths, for sizing pills. Generous on purpose: fonts differ per OS.
const width = {
  mono: (s, size = 13) => s.length * size * 0.62,
  label: (s, size = 11) => s.length * size * 0.72,
  body: (s, size = 14) => s.length * size * 0.54,
};

/** @keyframes from [[percent, css], ...]. */
function kf(name, stops) {
  return `@keyframes ${name}{${stops.map(([p, css]) => `${p}%{${css}}`).join("")}}`;
}

/** Opacity keyframes: hidden, fade in at `on`, fade out at `off` (percent of the loop). */
function showBetween(name, on, off, fade = 2) {
  return kf(name, [
    [0, "opacity:0"],
    [Math.max(0, on - 0.01), "opacity:0"],
    [on + fade, "opacity:1"],
    [off, "opacity:1"],
    [Math.min(100, off + fade), "opacity:0"],
    [100, "opacity:0"],
  ]);
}

/** Opacity keyframes: visible, fade out at `off`, back in at `back`. */
function hideBetween(name, off, back, fade = 2) {
  return kf(name, [
    [0, "opacity:1"],
    [off, "opacity:1"],
    [off + fade, "opacity:0"],
    [back, "opacity:0"],
    [Math.min(100, back + fade), "opacity:1"],
    [100, "opacity:1"],
  ]);
}

/** Move by (dx, dy) between `start` and `end`, visible only while moving. */
function travel(name, start, end, dx, dy) {
  return kf(name, [
    [0, "opacity:0;transform:translate(0px,0px)"],
    [Math.max(0, start - 0.01), "opacity:0;transform:translate(0px,0px)"],
    [start + 1, "opacity:1;transform:translate(0px,0px)"],
    [end - 1, `opacity:1;transform:translate(${dx}px,${dy}px)`],
    [end, `opacity:0;transform:translate(${dx}px,${dy}px)`],
    [100, `opacity:0;transform:translate(${dx}px,${dy}px)`],
  ]);
}

function doc({ w, h, t, title, desc, css, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<defs>
  <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="${t.grid}" stroke-width="1"/></pattern>
  <linearGradient id="gridFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <mask id="gridMask"><rect width="${w}" height="${h}" fill="url(#gridFade)"/></mask>
  <filter id="soft" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity="${t === THEMES.dark ? 0.45 : 0.08}"/></filter>
  <filter id="blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
</defs>
<style>
.lbl{font-family:${DISPLAY};font-weight:700;font-size:11px;letter-spacing:.14em;text-transform:uppercase;fill:${t.mute}}
.body{font-family:${BODY};font-size:14px;fill:${t.ink2}}
.title{font-family:${BODY};font-size:20px;font-weight:600;fill:${t.ink}}
.mono{font-family:${MONO};font-size:13px;fill:${t.ink}}
${css}
</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${t.bg}" stroke="${t.lineStrong}"/>
${t.grid === "none" ? "" : `<rect x="1" y="1" width="${w - 2}" height="${h - 2}" rx="10" fill="url(#grid)" mask="url(#gridMask)"/>`}
${crosshairs(w, h, t)}
${body}
</svg>
`;
}

function crosshairs(w, h, t) {
  const c = (x, y) => `<path d="M${x - 6} ${y}H${x + 6}M${x} ${y - 6}V${y + 6}" stroke="${t.cross}" stroke-width="1"/>`;
  return c(14, 14) + c(w - 14, 14) + c(14, h - 14) + c(w - 14, h - 14);
}

function browser(x, y, w, h, url, t) {
  return `<g filter="url(#soft)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${t.surface}" stroke="${t.lineStrong}"/></g>
<path d="M${x} ${y + 30}H${x + w}" stroke="${t.line}"/>
<circle cx="${x + 16}" cy="${y + 15}" r="4" fill="${t.lineStrong}"/><circle cx="${x + 30}" cy="${y + 15}" r="4" fill="${t.lineStrong}"/><circle cx="${x + 44}" cy="${y + 15}" r="4" fill="${t.lineStrong}"/>
<rect x="${x + 60}" y="${y + 7}" width="${w - 76}" height="16" rx="8" fill="${t.surface2}"/>
<text x="${x + 72}" y="${y + 19}" class="mono" style="font-size:10.5px;fill:${t.mute}">${esc(url)}</text>`;
}

function pill(x, y, text, t, kind = "accent", cls = "", mono = true) {
  const fill = { accent: t.accentTint, alert: t.alertTint, ok: t.okTint, plain: t.surface2 }[kind];
  const stroke = { accent: t.accentLine, alert: t.alertLine, ok: t.okLine, plain: t.lineStrong }[kind];
  const ink = { accent: t.accent, alert: t.alert, ok: t.ok, plain: t.ink2 }[kind];
  const w = (mono ? width.mono(text, 12) : width.label(text)) + 18;
  return `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="24" rx="4" fill="${fill}" stroke="${stroke}"/>
<text x="${x + 9}" y="${y + 16}" class="${mono ? "mono" : "lbl"}" style="${mono ? "font-size:12px;" : ""}fill:${ink}">${esc(text)}</text></g>`;
}

function check(x, y, color, size = 1) {
  return `<path d="M${x} ${y + 4 * size}l${3 * size} ${3 * size} ${6 * size}-${7 * size}" fill="none" stroke="${color}" stroke-width="${1.8 * size}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function cross(x, y, color, size = 1) {
  return `<path d="M${x} ${y}l${7 * size} ${7 * size}M${x + 7 * size} ${y}l-${7 * size} ${7 * size}" fill="none" stroke="${color}" stroke-width="${1.8 * size}" stroke-linecap="round"/>`;
}

function face(cx, cy, r, t) {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${t.face}"/>
<circle cx="${cx}" cy="${cy - r * 0.18}" r="${r * 0.36}" fill="${t.faceShade}"/>
<path d="M${cx - r * 0.62} ${cy + r * 0.72}c${r * 0.1}-${r * 0.5} ${r * 1.14}-${r * 0.5} ${r * 1.24} 0" fill="${t.faceShade}"/>`;
}

function mask(x, y, w, h, caption, t, cls = "") {
  return `<g class="${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${t.mask}"/>
<text x="${x + 8}" y="${y + h / 2 + 3.5}" class="lbl" style="font-size:9px;fill:${t.maskText}">${esc(caption)}</text></g>`;
}

function cloud(x, y, t) {
  return `<path d="M${x + 8} ${y + 18}a7 7 0 0 1 2-13.6a9 9 0 0 1 17 1.6a6 6 0 0 1 1 12z" fill="none" stroke="${t.accent}" stroke-width="1.6" stroke-linejoin="round"/>`;
}

// ─── 1. Hero ────────────────────────────────────────────────────────────
function hero(t) {
  const icon = readFileSync(join(root, "icons", "icon128.png")).toString("base64");
  const T = 10;
  const rows = [
    ["Full name", "Priya Sharma", "<PII_1>"],
    ["Aadhaar", "2345 6789 0124", "<ID_1>"],
    ["PAN", "ABCDE1234F", "<ID_2>"],
    ["Card", "4111 1111 1111 1111", "<CARD_1>"],
  ];
  const wx = 548, wy = 44, ww = 368, wh = 292;
  const scanTop = wy + 44, scanBottom = wy + 232, scanStart = 12, scanEnd = 40;
  const pctAt = (y) => scanStart + ((y - scanTop) / (scanBottom - scanTop)) * (scanEnd - scanStart);
  let css = kf("scan", [
    [0, `transform:translateY(0px);opacity:0`],
    [scanStart - 1, `transform:translateY(0px);opacity:0`],
    [scanStart, `transform:translateY(0px);opacity:1`],
    [scanEnd, `transform:translateY(${scanBottom - scanTop}px);opacity:1`],
    [scanEnd + 2, `transform:translateY(${scanBottom - scanTop}px);opacity:0`],
    [100, `transform:translateY(${scanBottom - scanTop}px);opacity:0`],
  ]);
  css += `.scan{animation:scan ${T}s linear infinite}`;
  let rowsSvg = "";
  rows.forEach(([label, raw, token], i) => {
    const ry = wy + 56 + i * 48;
    const p = pctAt(ry + 14);
    css += hideBetween(`raw${i}`, p, 90) + showBetween(`tok${i}`, p, 90);
    css += `.raw${i}{animation:raw${i} ${T}s infinite}.tok${i}{animation:tok${i} ${T}s infinite}`;
    rowsSvg += `<text x="${wx + 20}" y="${ry + 19}" class="lbl">${esc(label)}</text>
<rect x="${wx + 112}" y="${ry}" width="${ww - 132}" height="30" rx="4" fill="${t.bg}" stroke="${t.line}"/>
<text x="${wx + 124}" y="${ry + 20}" class="mono raw${i}" style="font-size:13.5px">${esc(raw)}</text>
${pill(wx + 118, ry + 3, token, t, "accent", `tok${i}`)}`;
  });
  css += showBetween("badge", 44, 90) + `.badge{animation:badge ${T}s infinite}`;
  const chips = ["On-device vision", "Token vault", "Fail-closed"];
  let cx = 48;
  let chipSvg = "";
  for (const c of chips) {
    const w = width.label(c) + 22;
    chipSvg += `<rect x="${cx}" y="262" width="${w}" height="26" rx="13" fill="${t.accentTint}" stroke="${t.accentLine}"/><text x="${cx + 11}" y="279" class="lbl" style="fill:${t.accent}">${esc(c)}</text>`;
    cx += w + 10;
  }
  const body = `
<image x="48" y="56" width="60" height="60" href="data:image/png;base64,${icon}" xlink:href="data:image/png;base64,${icon}" style="clip-path:inset(0 round 12px)"/>
<text x="124" y="104" style="font-family:${DISPLAY};font-weight:700;font-size:54px;letter-spacing:.06em;fill:${t.ink}">PAWTROL</text>
<text x="48" y="164" class="body" style="font-size:19px">The browser agent that does the clicking</text>
<text x="48" y="190" class="body" style="font-size:19px">and keeps your passwords, IDs and faces</text>
<text x="48" y="216" class="body" style="font-size:19px">on your own device.</text>
${chipSvg}
<text x="48" y="330" class="lbl">Smart India Hackathon 2026 · PS 26171 · ISRO</text>
${browser(wx, wy, ww, wh, "services.example.in/profile", t)}
${rowsSvg}
<g class="scan"><rect x="${wx + 8}" y="${scanTop - 36}" width="${ww - 16}" height="36" fill="url(#scanGlow)"/><rect x="${wx + 8}" y="${scanTop}" width="${ww - 16}" height="2" fill="${t.accent}"/></g>
<g class="badge"><rect x="${wx + 20}" y="${wy + wh - 42}" width="${ww - 40}" height="28" rx="4" fill="${t.okTint}" stroke="${t.okLine}"/>${check(wx + 32, wy + wh - 32, t.ok)}<text x="${wx + 50}" y="${wy + wh - 23}" class="body" style="font-size:13px;fill:${t.ok}">Only placeholders leave this device</text></g>
<defs><linearGradient id="scanGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity="0"/><stop offset="1" stop-color="${t.accent}" stop-opacity="${t.glow}"/></linearGradient></defs>`;
  return doc({
    w: 960, h: 380, t, css, body,
    title: "Pawtrol",
    desc: "A form with a name, Aadhaar, PAN and card number is scanned; each value turns into a placeholder token before anything leaves the device.",
  });
}

// ─── 2. The problem ─────────────────────────────────────────────────────
function problem(t) {
  const T = 11;
  const wx = 40, wy = 104, ww = 380, wh = 262;
  const cxBox = 620, cyBox = 118, cw = 300, ch = 248;
  const packets = [
    { text: "screenshot", at: 10, shot: true },
    { text: "2345 6789 0124", at: 26 },
    { text: "hunter2", at: 40 },
    { text: "priya.sharma@example.com", at: 54 },
  ];
  const received = ["photo of your face", "Aadhaar 2345 6789 0124", "password hunter2", "priya.sharma@example.com"];
  let css = "";
  let packetSvg = "";
  let logSvg = "";
  packets.forEach((p, i) => {
    const y = wy + 110 + i * 10;
    css += travel(`pk${i}`, p.at, p.at + 12, cxBox - (wx + ww) - 70, 0) + `.pk${i}{animation:pk${i} ${T}s infinite}`;
    packetSvg += p.shot
      ? `<g class="pk${i}"><rect x="${wx + ww + 16}" y="${y - 14}" width="54" height="40" rx="3" fill="${t.surface}" stroke="${t.alert}"/>${face(wx + ww + 30, y + 2, 8, t)}<rect x="${wx + ww + 42}" y="${y - 4}" width="22" height="4" fill="${t.alertLine}"/><rect x="${wx + ww + 42}" y="${y + 4}" width="18" height="4" fill="${t.alertLine}"/></g>`
      : pill(wx + ww + 12, y - 12, p.text, t, "alert", `pk${i}`);
    css += showBetween(`rc${i}`, p.at + 12, 92) + `.rc${i}{animation:rc${i} ${T}s infinite}`;
    logSvg += `<g class="rc${i}">${cross(cxBox + 22, cyBox + 64 + i * 38, t.alert, 0.9)}<text x="${cxBox + 40}" y="${cyBox + 71 + i * 38}" class="mono" style="font-size:12.5px;fill:${t.alert}">${esc(received[i])}</text></g>`;
  });
  css += showBetween("warn", 70, 92) + `.warn{animation:warn ${T}s infinite}`;
  const rows = [
    ["Aadhaar", "2345 6789 0124"],
    ["Password", "••••••••"],
    ["Email", "priya.sharma@example.com"],
  ];
  const body = `
<text x="40" y="48" class="lbl" style="fill:${t.alert}">Without Pawtrol</text>
<text x="40" y="78" class="title">A normal AI agent sends whatever it sees to the cloud.</text>
${browser(wx, wy, ww, wh, "bank.example.in/kyc", t)}
${face(wx + 44, wy + 70, 24, t)}
<text x="${wx + 80}" y="${wy + 66}" class="body" style="fill:${t.ink};font-weight:600">Priya Sharma</text>
<text x="${wx + 80}" y="${wy + 86}" class="body" style="font-size:12px">KYC update</text>
${rows
  .map(
    ([l, v], i) => `<text x="${wx + 20}" y="${wy + 138 + i * 40}" class="lbl">${l}</text>
<rect x="${wx + 104}" y="${wy + 118 + i * 40}" width="${ww - 124}" height="30" rx="4" fill="${t.bg}" stroke="${t.line}"/>
<text x="${wx + 114}" y="${wy + 138 + i * 40}" class="mono" style="font-size:12.5px">${esc(v)}</text>`,
  )
  .join("")}
<path d="M${wx + ww + 10} ${wy + 132}H${cxBox - 10}" stroke="${t.lineStrong}" stroke-dasharray="4 5"/>
<path d="M${cxBox - 16} ${wy + 127}l6 5-6 5" fill="none" stroke="${t.lineStrong}"/>
<text x="${wx + ww + 18}" y="${wy + 170}" class="lbl">screenshot + page text</text>
${packetSvg}
<g filter="url(#soft)"><rect x="${cxBox}" y="${cyBox}" width="${cw}" height="${ch}" rx="8" fill="${t.surface}" stroke="${t.lineStrong}"/></g>
${cloud(cxBox + 18, cyBox + 16, t)}
<text x="${cxBox + 56}" y="${cyBox + 32}" class="lbl" style="fill:${t.ink2}">Cloud AI model</text>
<text x="${cxBox + 22}" y="${cyBox + 52}" class="lbl" style="font-size:9.5px">What it received</text>
${logSvg}
<g class="warn"><rect x="40" y="386" width="880" height="30" rx="4" fill="${t.alertTint}" stroke="${t.alertLine}"/>
<text x="56" y="406" class="body" style="font-size:13.5px;fill:${t.alert}">The password shows as dots, but the page still holds it, and your face and ID leave in the screenshot.</text></g>`;
  return doc({
    w: 960, h: 436, t, css, body,
    title: "The problem",
    desc: "Without Pawtrol, an AI agent sends the screenshot and page text to a cloud model, including a face photo, an Aadhaar number, a password and an email.",
  });
}

// ─── 3. The solution ────────────────────────────────────────────────────
function solution(t) {
  const T = 15;
  const dx = 24, dy = 104, dw = 620, dh = 318; // device boundary
  const px = 44, py = 128, pw = 250, ph = 276; // page
  const vx = 318, vy = 128, vw = 304, vh = 276; // vault
  const cx = 704, cy = 152, cw = 232, ch = 228; // cloud
  const vault = [
    ["2345 6789 0124", "<ID_1>", "accent"],
    ["Priya Sharma", "<PII_1>", "accent"],
    ["hunter2", "withheld", "alert"],
    ["face photo", "blurred", "ok"],
  ];
  let css = "";
  let vaultSvg = "";
  vault.forEach(([raw, tok, kind], i) => {
    const y = vy + 70 + i * 40;
    const on = 12 + i * 4;
    css += showBetween(`v${i}`, on, 92) + `.v${i}{animation:v${i} ${T}s infinite}`;
    vaultSvg += `<g class="v${i}"><text x="${vx + 18}" y="${y + 16}" class="mono" style="font-size:12px;fill:${t.ink2}">${esc(raw)}</text>
<path d="M${vx + 150} ${y + 12}h18m-5-4 5 4-5 4" fill="none" stroke="${t.mute}"/>${pill(vx + 178, y, tok, t, kind)}</g>`;
  });
  // Packets.
  css += travel("p1", 3, 11, vx - (px + pw) + 20, 0) + `.p1{animation:p1 ${T}s infinite}`;
  css += travel("p2", 32, 44, cx - (vx + vw) + 4, 0) + `.p2{animation:p2 ${T}s infinite}`;
  css += travel("p3", 58, 68, -(cx - (vx + vw) + 4), 0) + `.p3{animation:p3 ${T}s infinite}`;
  css += travel("p4", 72, 80, -(vx - (px + pw) + 20), 0) + `.p4{animation:p4 ${T}s infinite}`;
  css += showBetween("sees", 44, 92) + `.sees{animation:sees ${T}s infinite}`;
  css += showBetween("plans", 52, 92) + `.plans{animation:plans ${T}s infinite}`;
  css += showBetween("resolve", 69, 92) + `.resolve{animation:resolve ${T}s infinite}`;
  // Typing into the search field.
  // scaleX, not width: Safari does not animate SVG geometry properties.
  css += kf("typing", [
    [0, "transform:scaleX(0)"],
    [80, "transform:scaleX(0)"],
    [86, "transform:scaleX(1)"],
    [95, "transform:scaleX(1)"],
    [97, "transform:scaleX(0)"],
    [100, "transform:scaleX(0)"],
  ]) + `.typing{transform-box:fill-box;transform-origin:left center;animation:typing ${T}s steps(14,end) infinite}`;
  css += showBetween("done", 86, 95) + `.done{animation:done ${T}s infinite}`;
  const steps = [
    ["1", "Detect", 0, 30],
    ["2", "Swap for tokens", 30, 52],
    ["3", "Plan in the cloud", 52, 70],
    ["4", "Fill in locally", 70, 97],
  ];
  let stepSvg = "";
  let sx = 40;
  steps.forEach(([n, label, on, off], i) => {
    css += showBetween(`st${i}`, on, off, 1) + `.st${i}{animation:st${i} ${T}s infinite}`;
    const w = width.label(label) + 44;
    stepSvg += `<g><rect x="${sx}" y="438" width="${w}" height="28" rx="14" fill="${t.bg}" stroke="${t.lineStrong}"/>
<g class="st${i}"><rect x="${sx}" y="438" width="${w}" height="28" rx="14" fill="${t.accentTint}" stroke="${t.accent}"/></g>
<circle cx="${sx + 14}" cy="452" r="8" fill="${t.surface2}" stroke="${t.lineStrong}"/><text x="${sx + 14}" y="456" text-anchor="middle" class="lbl" style="font-size:10px;fill:${t.ink2}">${n}</text>
<text x="${sx + 30}" y="456" class="lbl" style="fill:${t.ink2}">${esc(label)}</text></g>`;
    sx += w + 14;
  });
  const body = `
<text x="40" y="48" class="lbl" style="fill:${t.ok}">With Pawtrol</text>
<text x="40" y="78" class="title">The AI plans with placeholders. Real values never leave your device.</text>
<rect x="${dx}" y="${dy}" width="${dw}" height="${dh}" rx="10" fill="none" stroke="${t.accent}" stroke-dasharray="6 6" opacity="0.8"/>
<rect x="${dx + 16}" y="${dy - 10}" width="92" height="20" rx="3" fill="${t.bg}"/><text x="${dx + 24}" y="${dy + 4}" class="lbl" style="fill:${t.accent}">Your device</text>
${browser(px, py, pw, ph, "bank.example.in/kyc", t)}
${face(px + 36, py + 64, 20, t)}
<text x="${px + 66}" y="${py + 68}" class="body" style="fill:${t.ink};font-weight:600;font-size:13px">Priya Sharma</text>
<text x="${px + 16}" y="${py + 118}" class="lbl">Aadhaar</text>
<rect x="${px + 16}" y="${py + 126}" width="${pw - 32}" height="28" rx="4" fill="${t.bg}" stroke="${t.line}"/>
<text x="${px + 26}" y="${py + 145}" class="mono" style="font-size:12.5px">2345 6789 0124</text>
<text x="${px + 16}" y="${py + 184}" class="lbl">Search</text>
<rect x="${px + 16}" y="${py + 192}" width="${pw - 32}" height="28" rx="4" fill="${t.bg}" stroke="${t.accentLine}"/>
<clipPath id="typeClip"><rect class="typing" x="${px + 26}" y="${py + 192}" width="140" height="28"/></clipPath>
<text x="${px + 26}" y="${py + 211}" class="mono" style="font-size:12.5px" clip-path="url(#typeClip)">2345 6789 0124</text>
<g filter="url(#soft)"><rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" rx="8" fill="${t.surface}" stroke="${t.accentLine}"/></g>
<text x="${vx + 18}" y="${vy + 30}" class="lbl" style="fill:${t.accent}">Pawtrol · token vault</text>
<text x="${vx + 18}" y="${vy + 52}" class="body" style="font-size:12px">Stays in the browser, cleared after every task</text>
${vaultSvg}
<g class="resolve"><rect x="${vx + 18}" y="${vy + vh - 44}" width="${vw - 36}" height="28" rx="4" fill="${t.okTint}" stroke="${t.okLine}"/>
<text x="${vx + 30}" y="${vy + vh - 25}" class="mono" style="font-size:12px;fill:${t.ok}">&lt;ID_1&gt; → 2345 6789 0124, typed here</text></g>
<g filter="url(#soft)"><rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="8" fill="${t.surface}" stroke="${t.lineStrong}"/></g>
${cloud(cx + 16, cy + 14, t)}
<text x="${cx + 54}" y="${cy + 30}" class="lbl" style="fill:${t.ink2}">Cloud AI model</text>
<g class="sees"><text x="${cx + 18}" y="${cy + 62}" class="lbl" style="font-size:9.5px">It sees</text>
${pill(cx + 18, cy + 72, "<ID_1>", t)}${pill(cx + 88, cy + 72, "<PII_1>", t)}
<rect x="${cx + 18}" y="${cy + 106}" width="70" height="42" rx="3" fill="${t.bg}" stroke="${t.lineStrong}"/><circle cx="${cx + 34}" cy="${cy + 122}" r="9" fill="${t.faceShade}" filter="url(#blur)"/><rect x="${cx + 48}" y="${cy + 114}" width="32" height="8" fill="${t.mask}"/><rect x="${cx + 48}" y="${cy + 128}" width="24" height="8" fill="${t.mask}"/>
<text x="${cx + 98}" y="${cy + 124}" class="body" style="font-size:11.5px">masked</text><text x="${cx + 98}" y="${cy + 140}" class="body" style="font-size:11.5px">screenshot</text></g>
<g class="plans"><text x="${cx + 18}" y="${cy + 178}" class="lbl" style="font-size:9.5px">It answers</text>
<text x="${cx + 18}" y="${cy + 200}" class="mono" style="font-size:12px;fill:${t.accent}">type &lt;ID_1&gt; into Search</text></g>
${pill(px + pw - 6, py + 132, "2345 6789 0124", t, "alert", "p1")}
${pill(vx + vw - 60, cy + 76, "<ID_1> <PII_1>", t, "accent", "p2")}
${pill(cx - 30, cy + 152, "type <ID_1>", t, "accent", "p3")}
${pill(vx - 20, py + 196, "2345 6789 0124", t, "ok", "p4")}
<g class="done"><rect x="${cx}" y="${cy + ch + 16}" width="${cw}" height="30" rx="4" fill="${t.okTint}" stroke="${t.okLine}"/>${check(cx + 12, cy + ch + 27, t.ok)}<text x="${cx + 30}" y="${cy + ch + 36}" class="body" style="font-size:12.5px;fill:${t.ok}">Done. The cloud never saw it.</text></g>
${stepSvg}`;
  return doc({
    w: 960, h: 486, t, css, body,
    title: "How Pawtrol solves it",
    desc: "Pawtrol swaps the Aadhaar number for the token ID_1 and the name for PII_1, withholds the password and blurs the face. The cloud model only sees tokens and a masked screenshot, answers 'type ID_1 into Search', and Pawtrol types the real number into the page locally.",
  });
}

// ─── 4. Six layers + fail closed ────────────────────────────────────────
function pipeline(t) {
  const T = 16;
  const cards = [
    ["01", "Detect", "DOM, patterns,", "checksums"],
    ["02", "Tokenize", "values become", "<ID_1>, <CARD_1>"],
    ["03", "Redact", "anything left over", "becomes [REDACTED]"],
    ["04", "Mask pixels", "OCR text and faces", "on the screenshot"],
    ["05", "Verify", "re-read every mask", "with OCR"],
    ["06", "Send gate", "only verified", "data may leave"],
  ];
  const cy = 108, cw = 140, ch = 104, gap = 16, x0 = 24;
  const centre = (i) => x0 + i * (cw + gap) + cw / 2;
  const railY = cy + ch + 34;
  let css = "";
  let cardSvg = "";
  // Pass A (0-50%): all six light up, then "sent". Pass B (50-100%): verify fails.
  cards.forEach(([n, title, a, b], i) => {
    const x = x0 + i * (cw + gap);
    const onA = 4 + i * 6;
    const onB = 54 + i * 6;
    const failing = i === 4;
    css += kf(`c${i}`, [
      [0, "opacity:0"],
      [onA, "opacity:0"],
      [onA + 2, "opacity:1"],
      [46, "opacity:1"],
      [48, "opacity:0"],
      [onB, "opacity:0"],
      [onB + 2, failing ? "opacity:0" : i > 4 ? "opacity:0" : "opacity:1"],
      [96, failing || i > 4 ? "opacity:0" : "opacity:1"],
      [98, "opacity:0"],
      [100, "opacity:0"],
    ]) + `.c${i}{animation:c${i} ${T}s infinite}`;
    cardSvg += `<rect x="${x}" y="${cy}" width="${cw}" height="${ch}" rx="6" fill="${t.surface}" stroke="${t.lineStrong}"/>
<g class="c${i}"><rect x="${x}" y="${cy}" width="${cw}" height="${ch}" rx="6" fill="${t.accentTint}" stroke="${t.accent}"/></g>
<text x="${x + 14}" y="${cy + 26}" class="mono" style="font-size:11px;fill:${t.mute}">${n}</text>
<text x="${x + 14}" y="${cy + 50}" class="lbl" style="font-size:13px;fill:${t.ink}">${esc(title)}</text>
<text x="${x + 14}" y="${cy + 72}" class="body" style="font-size:11.5px">${esc(a)}</text>
<text x="${x + 14}" y="${cy + 88}" class="body" style="font-size:11.5px">${esc(b)}</text>`;
  });
  // Verify card turns red in pass B.
  css += showBetween("vfail", 78, 96, 1) + `.vfail{animation:vfail ${T}s infinite}`;
  const vx = x0 + 4 * (cw + gap);
  // Moving dot along the rail.
  const dotStops = [[0, `transform:translate(0px,0px);opacity:0`]];
  cards.forEach((_, i) => dotStops.push([4 + i * 6, `transform:translate(${centre(i) - centre(0)}px,0px);opacity:1`]));
  dotStops.push([40, `transform:translate(${centre(5) - centre(0)}px,0px);opacity:1`]);
  dotStops.push([42, `transform:translate(${centre(5) - centre(0)}px,34px);opacity:1`]);
  dotStops.push([46, `transform:translate(${centre(5) - centre(0)}px,34px);opacity:0`]);
  dotStops.push([52, `transform:translate(0px,0px);opacity:0`]);
  for (let i = 0; i <= 4; i++) dotStops.push([54 + i * 6, `transform:translate(${centre(i) - centre(0)}px,0px);opacity:1`]);
  dotStops.push([80, `transform:translate(${centre(4) - centre(0)}px,0px);opacity:1`]);
  dotStops.push([83, `transform:translate(${centre(4) - centre(0)}px,34px);opacity:1`]);
  dotStops.push([95, `transform:translate(${centre(4) - centre(0)}px,34px);opacity:0`]);
  dotStops.push([100, `transform:translate(0px,0px);opacity:0`]);
  css += kf("dot", dotStops) + `.dot{animation:dot ${T}s infinite}`;
  css += showBetween("sent", 42, 48, 1) + `.sent{animation:sent ${T}s infinite}`;
  css += showBetween("blocked", 83, 96, 1) + `.blocked{animation:blocked ${T}s infinite}`;
  // Ledger: one entry per lit step, both passes.
  let ledger = "";
  const times = [...cards.map((_, i) => 4 + i * 6), 42, ...[0, 1, 2, 3, 4].map((i) => 54 + i * 6), 83];
  times.forEach((at, i) => {
    const x = 196 + i * 50;
    const bad = i === times.length - 1;
    const sent = i === 6;
    css += showBetween(`l${i}`, at, 96, 1) + `.l${i}{animation:l${i} ${T}s infinite}`;
    ledger += `<g class="l${i}">${i > 0 ? `<path d="M${x - 30} 331H${x - 4}" stroke="${t.lineStrong}"/>` : ""}<rect x="${x - 4}" y="321" width="20" height="20" rx="3" fill="${bad ? t.alertTint : sent ? t.okTint : t.surface2}" stroke="${bad ? t.alert : sent ? t.ok : t.accentLine}"/></g>`;
  });
  const sentW = width.label("Sent to the model") + 44;
  const blockW = width.label("Nothing sent. Fail closed") + 44;
  const chip = (w, cls, x, text, ink, fill, stroke, icon) =>
    `<g class="${cls}"><rect x="${x}" y="${railY + 22}" width="${w}" height="26" rx="4" fill="${fill}" stroke="${stroke}"/>${icon(x + 12, railY + 31, ink)}<text x="${x + 30}" y="${railY + 39}" class="lbl" style="fill:${ink}">${esc(text)}</text></g>`;
  const body = `
<text x="40" y="48" class="lbl">Every step, every time</text>
<text x="40" y="78" class="title">Six checks run on the device before anything reaches a model.</text>
${cardSvg}
<g class="vfail"><rect x="${vx}" y="${cy}" width="${cw}" height="${ch}" rx="6" fill="${t.alertTint}" stroke="${t.alert}"/>
<text x="${vx + 14}" y="${cy + 26}" class="mono" style="font-size:11px;fill:${t.alert}">05</text>
<text x="${vx + 14}" y="${cy + 50}" class="lbl" style="font-size:13px;fill:${t.alert}">Verify failed</text>
<text x="${vx + 14}" y="${cy + 72}" class="body" style="font-size:11.5px;fill:${t.alert}">a mask could</text>
<text x="${vx + 14}" y="${cy + 88}" class="body" style="font-size:11.5px;fill:${t.alert}">still be read</text></g>
<path d="M${centre(0)} ${railY}H${centre(5)}" stroke="${t.lineStrong}" stroke-dasharray="2 5"/>
${cards.map((_, i) => `<circle cx="${centre(i)}" cy="${railY}" r="3" fill="${t.lineStrong}"/>`).join("")}
<g class="dot"><circle cx="${centre(0)}" cy="${railY}" r="7" fill="${t.accent}" opacity="0.25"/><circle cx="${centre(0)}" cy="${railY}" r="4" fill="${t.accent}"/></g>
${chip(sentW, "sent", Math.min(centre(5) - sentW / 2, 936 - sentW), "Sent to the model", t.ok, t.okTint, t.okLine, check)}
${chip(blockW, "blocked", centre(4) - blockW / 2, "Nothing sent. Fail closed", t.alert, t.alertTint, t.alertLine, cross)}
<text x="40" y="335" class="lbl">Privacy ledger</text>
<text x="40" y="351" class="lbl" style="font-size:9px">SHA-256 chain · counts only</text>
${ledger}`;
  return doc({
    w: 960, h: 372, t, css, body,
    title: "Six privacy layers",
    desc: "Detect, tokenize, redact, mask pixels, verify and a send gate run in order. In the first pass everything passes and the data is sent. In the second pass verification fails and nothing is sent. Every step is written to a hash-chained privacy ledger.",
  });
}

// ─── 5. On-device vision ────────────────────────────────────────────────
function vision(t) {
  const T = 13;
  const wx = 40, wy = 100, ww = 470, wh = 280;
  const card = { x: wx + 24, y: wy + 70, w: 300, h: 172 };
  const boxes = [
    [card.x + 14, card.y + 12, 64, 76, "face"],
    [card.x + 92, card.y + 16, 150, 16],
    [card.x + 92, card.y + 44, 120, 18],
    [card.x + 92, card.y + 72, 48, 14],
    [card.x + 92, card.y + 104, 190, 30, "id"],
    [wx + 24, wy + 44, 200, 16],
  ];
  let css = "";
  let boxSvg = "";
  boxes.forEach(([x, y, w, h], i) => {
    css += showBetween(`b${i}`, 8 + i * 2, 36, 1) + `.b${i}{animation:b${i} ${T}s infinite}`;
    boxSvg += `<rect class="b${i}" x="${x - 4}" y="${y - 4}" width="${w + 8}" height="${h + 8}" rx="3" fill="none" stroke="${t.accent}" stroke-width="1.4" stroke-dasharray="4 3"/>`;
  });
  css += showBetween("read", 22, 34, 1) + `.read{animation:read ${T}s infinite}`;
  css += showBetween("idmask", 38, 92) + `.idmask{animation:idmask ${T}s infinite}`;
  css += showBetween("fblur", 44, 92) + `.fblur{animation:fblur ${T}s infinite}`;
  css += hideBetween("fsharp", 44, 92) + `.fsharp{animation:fsharp ${T}s infinite}`;
  css += showBetween("stamp", 54, 92) + `.stamp{animation:stamp ${T}s infinite}`;
  const log = [
    ["PP-OCRv4", "5 text regions", 10],
    ["YuNet", "1 face", 16],
    ["OCR", "12 digits in the image", 24],
    ["Checksum", "Verhoeff valid: Aadhaar", 30],
    ["Mask", "Aadhaar hidden", 38],
    ["Blur", "face", 44],
    ["Re-OCR", "nothing readable", 52],
    ["Send gate", "verified, may leave", 58],
  ];
  let logSvg = "";
  const lx = 548, ly = 100;
  log.forEach(([k, v, at], i) => {
    css += showBetween(`g${i}`, at, 92, 1) + `.g${i}{animation:g${i} ${T}s infinite}`;
    const good = i >= 6;
    logSvg += `<g class="g${i}"><text x="${lx + 20}" y="${ly + 64 + i * 26}" class="mono" style="font-size:12px;fill:${t.mute}">${esc(k)}</text>
<text x="${lx + 118}" y="${ly + 64 + i * 26}" class="mono" style="font-size:12px;fill:${good ? t.ok : t.ink}">${esc(v)}</text></g>`;
  });
  const idY = card.y + 104;
  const body = `
<text x="40" y="48" class="lbl">It reads the screen, not just the code</text>
<text x="40" y="78" class="title">Text drawn as pixels is found and masked on the device.</text>
${browser(wx, wy, ww, wh, "kyc.example.in/upload", t)}
<text x="${wx + 24}" y="${wy + 58}" class="body" style="fill:${t.ink};font-weight:600">Uploaded ID card</text>
<rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="8" fill="${t.surface2}" stroke="${t.lineStrong}"/>
<text x="${card.x + card.w + 12}" y="${card.y + 14}" class="lbl" style="font-size:9px">&lt;canvas&gt;</text>
<g class="fsharp">${face(card.x + 46, card.y + 50, 30, t)}</g>
<g class="fblur" filter="url(#blur)">${face(card.x + 46, card.y + 50, 30, t)}</g>
<text x="${card.x + 92}" y="${card.y + 29}" class="lbl" style="font-size:10px">Government of India</text>
<text x="${card.x + 92}" y="${card.y + 58}" class="body" style="font-size:15px;fill:${t.ink};font-weight:600">Priya Sharma</text>
<text x="${card.x + 92}" y="${card.y + 82}" class="body" style="font-size:11px">Aadhaar</text>
<text x="${card.x + 92}" y="${idY + 21}" class="mono" style="font-size:19px;letter-spacing:.04em">2345 6789 0124</text>
<rect class="read" x="${card.x + 88}" y="${idY - 4}" width="198" height="38" rx="3" fill="${t.accent}" fill-opacity="0.18"/>
${mask(card.x + 88, idY - 4, 198, 38, "Aadhaar hidden", t, "idmask")}
${boxSvg}
<g class="stamp"><rect x="${card.x + card.w - 94}" y="${card.y + card.h - 34}" width="86" height="24" rx="4" fill="${t.okTint}" stroke="${t.ok}"/>${check(card.x + card.w - 84, card.y + card.h - 26, t.ok)}<text x="${card.x + card.w - 68}" y="${card.y + card.h - 18}" class="lbl" style="fill:${t.ok}">Verified</text></g>
<g filter="url(#soft)"><rect x="${lx}" y="${ly}" width="372" height="${wh}" rx="8" fill="${t.surface}" stroke="${t.lineStrong}"/></g>
<text x="${lx + 20}" y="${ly + 30}" class="lbl" style="fill:${t.ink2}">Offscreen vision pipeline</text>
<text x="${lx + 352}" y="${ly + 30}" text-anchor="end" class="lbl" style="font-size:9.5px;fill:${t.accent}">WebGPU · WASM fallback</text>
<path d="M${lx} ${ly + 42}H${lx + 372}" stroke="${t.line}"/>
${logSvg}`;
  return doc({
    w: 960, h: 404, t, css, body,
    title: "On-device vision",
    desc: "On an ID card drawn on a canvas, PP-OCRv4 finds five text regions and YuNet finds one face. OCR reads twelve digits, the Verhoeff checksum confirms an Aadhaar number, it is masked, the face is blurred, and a second OCR pass confirms nothing is readable before the image may leave.",
  });
}

// ─── 6. Page launcher ───────────────────────────────────────────────────
function launcher(t) {
  const T = 15;
  const wx = 40, wy = 40, ww = 880, wh = 360;
  const fab = { x: wx + ww - 52, y: wy + wh - 52 };
  const card = { x: wx + ww - 372, y: wy + wh - 262, w: 340, h: 196 };
  let css = "";
  // Cursor path: to the FAB, click, later to Allow.
  const allow = { x: card.x + card.w - 56, y: card.y + card.h - 34 };
  css += kf("cursor", [
    [0, `transform:translate(${wx + 420}px,${wy + 200}px);opacity:0`],
    [2, `transform:translate(${wx + 420}px,${wy + 200}px);opacity:1`],
    [9, `transform:translate(${fab.x + 4}px,${fab.y + 6}px);opacity:1`],
    [50, `transform:translate(${fab.x + 4}px,${fab.y + 6}px);opacity:1`],
    [56, `transform:translate(${allow.x}px,${allow.y}px);opacity:1`],
    [62, `transform:translate(${allow.x}px,${allow.y}px);opacity:1`],
    [70, `transform:translate(${allow.x + 60}px,${allow.y + 60}px);opacity:0`],
    [100, `transform:translate(${allow.x + 60}px,${allow.y + 60}px);opacity:0`],
  ]) + `.cursor{animation:cursor ${T}s infinite}`;
  css += kf("ripple", [
    [0, "opacity:0;transform:scale(.4)"],
    [9.5, "opacity:0;transform:scale(.4)"],
    [10, "opacity:.6;transform:scale(.4)"],
    [13, "opacity:0;transform:scale(1.4)"],
    [100, "opacity:0;transform:scale(1.4)"],
  ]) + `.ripple{transform-box:fill-box;transform-origin:center;animation:ripple ${T}s infinite}`;
  css += kf("ripple2", [
    [0, "opacity:0;transform:scale(.4)"],
    [60.5, "opacity:0;transform:scale(.4)"],
    [61, "opacity:.6;transform:scale(.4)"],
    [64, "opacity:0;transform:scale(1.4)"],
    [100, "opacity:0;transform:scale(1.4)"],
  ]) + `.ripple2{transform-box:fill-box;transform-origin:center;animation:ripple2 ${T}s infinite}`;
  css += showBetween("card", 11, 94) + `.card{animation:card ${T}s infinite}`;
  css += showBetween("form", 11, 30, 1) + `.form{animation:form ${T}s infinite}`;
  css += kf("type", [
    [0, "transform:scaleX(0)"],
    [13, "transform:scaleX(0)"],
    [27, "transform:scaleX(1)"],
    [94, "transform:scaleX(1)"],
    [96, "transform:scaleX(0)"],
    [100, "transform:scaleX(0)"],
  ]) + `.type{transform-box:fill-box;transform-origin:left center;animation:type ${T}s steps(31,end) infinite}`;
  const status = [
    ["Read the page", 32, 38],
    ["Click Monday 29", 38, 44],
    ["Click 9:30 AM", 44, 50],
  ];
  let statusSvg = "";
  status.forEach(([text, on, off], i) => {
    css += showBetween(`s${i}`, on, off, 0.5) + `.s${i}{animation:s${i} ${T}s infinite}`;
    statusSvg += `<g class="s${i}"><rect x="${card.x + 14}" y="${card.y + 44}" width="${card.w - 28}" height="44" rx="4" fill="${t.surface2}"/>
<text x="${card.x + 26}" y="${card.y + 71}" class="mono" style="font-size:12.5px">${esc(text)}</text>
<rect x="${card.x + card.w - 86}" y="${card.y + card.h - 48}" width="72" height="32" rx="4" fill="${t.bg}" stroke="${t.lineStrong}"/><text x="${card.x + card.w - 67}" y="${card.y + card.h - 27}" class="lbl" style="fill:${t.alert}">Stop</text></g>`;
  });
  css += showBetween("confirm", 50, 62, 0.5) + `.confirm{animation:confirm ${T}s infinite}`;
  css += showBetween("answer", 63, 94) + `.answer{animation:answer ${T}s infinite}`;
  css += showBetween("mon", 40, 94, 1) + `.mon{animation:mon ${T}s infinite}`;
  css += showBetween("slot", 46, 94, 1) + `.slot{animation:slot ${T}s infinite}`;
  css += showBetween("booked", 63, 94, 1) + `.booked{animation:booked ${T}s infinite}`;
  css += kf("spin", [[0, "transform:rotate(0deg)"], [100, "transform:rotate(360deg)"]]);
  css += showBetween("busy", 31, 63, 0.5) + `.busy{animation:busy ${T}s infinite}.spinner{transform-box:fill-box;transform-origin:center;animation:spin 1s linear infinite}`;
  const days = ["Mon 29", "Tue 30", "Wed 1", "Thu 2", "Fri 3"];
  const slots = ["9:30 AM", "11:00 AM", "2:15 PM", "4:00 PM"];
  const pageSvg = `
<text x="${wx + 32}" y="${wy + 72}" class="title" style="font-size:18px">Book an appointment</text>
<text x="${wx + 32}" y="${wy + 94}" class="body" style="font-size:12.5px">Choose a day, then a time.</text>
${days
  .map(
    (d, i) => `<rect x="${wx + 32 + i * 92}" y="${wy + 116}" width="80" height="52" rx="6" fill="${t.bg}" stroke="${t.lineStrong}"/>
${i === 0 ? `<rect class="mon" x="${wx + 32}" y="${wy + 116}" width="80" height="52" rx="6" fill="${t.accentTint}" stroke="${t.accent}"/>` : ""}
<text x="${wx + 72 + i * 92}" y="${wy + 147}" text-anchor="middle" class="lbl" style="fill:${t.ink2}">${d}</text>`,
  )
  .join("")}
${slots
  .map(
    (s, i) => `<rect x="${wx + 32 + i * 116}" y="${wy + 192}" width="104" height="34" rx="17" fill="${t.bg}" stroke="${t.lineStrong}"/>
${i === 0 ? `<rect class="slot" x="${wx + 32}" y="${wy + 192}" width="104" height="34" rx="17" fill="${t.accentTint}" stroke="${t.accent}"/>` : ""}
<text x="${wx + 84 + i * 116}" y="${wy + 214}" text-anchor="middle" class="mono" style="font-size:12px;fill:${t.ink2}">${s}</text>`,
  )
  .join("")}
<g class="booked"><rect x="${wx + 32}" y="${wy + 250}" width="236" height="30" rx="4" fill="${t.okTint}" stroke="${t.okLine}"/>${check(wx + 44, wy + 261, t.ok)}<text x="${wx + 62}" y="${wy + 270}" class="body" style="font-size:12.5px;fill:${t.ok}">Booked: Monday 29, 9:30 AM</text></g>`;
  const body = `
${browser(wx, wy, ww, wh, "clinic.example.in/appointments", t)}
${pageSvg}
<g class="card" filter="url(#soft)"><rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="6" fill="${t.bg}" stroke="${t.lineStrong}"/></g>
<g class="card">
<text x="${card.x + 14}" y="${card.y + 26}" class="lbl">Pawtrol · this tab</text>
<path d="M${card.x + card.w - 26} ${card.y + 16}l8 8m0-8-8 8" stroke="${t.mute}" stroke-width="1.4"/>
<g class="form"><rect x="${card.x + 14}" y="${card.y + 44}" width="${card.w - 84}" height="34" rx="4" fill="${t.surface2}" stroke="${t.accent}"/>
<clipPath id="typeClip2"><rect class="type" x="${card.x + 24}" y="${card.y + 44}" width="230" height="34"/></clipPath>
<text x="${card.x + 24}" y="${card.y + 66}" class="body" style="font-size:12.5px;fill:${t.ink}" clip-path="url(#typeClip2)">Book the earliest slot on Monday</text>
<rect x="${card.x + card.w - 62}" y="${card.y + 44}" width="48" height="34" rx="4" fill="${t.accent}"/><text x="${card.x + card.w - 49}" y="${card.y + 66}" class="lbl" style="fill:${t.onAccent}">Go</text>
<text x="${card.x + 14}" y="${card.y + 104}" class="body" style="font-size:11.5px;fill:${t.mute}">Pawtrol takes control of this tab.</text>
<text x="${card.x + 14}" y="${card.y + 120}" class="body" style="font-size:11.5px;fill:${t.mute}">Personal data is redacted on your device first.</text></g>
${statusSvg}
<g class="confirm"><rect x="${card.x + 14}" y="${card.y + 44}" width="${card.w - 28}" height="44" rx="4" fill="${t.surface2}"/>
<text x="${card.x + 26}" y="${card.y + 71}" class="body" style="font-size:12.5px;fill:${t.ink}">Allow this? Confirm the booking</text>
<rect x="${card.x + card.w - 170}" y="${card.y + card.h - 48}" width="72" height="32" rx="4" fill="${t.bg}" stroke="${t.lineStrong}"/><text x="${card.x + card.w - 152}" y="${card.y + card.h - 27}" class="lbl" style="fill:${t.alert}">Deny</text>
<rect x="${card.x + card.w - 86}" y="${card.y + card.h - 48}" width="72" height="32" rx="4" fill="${t.accent}"/><text x="${card.x + card.w - 68}" y="${card.y + card.h - 27}" class="lbl" style="fill:${t.onAccent}">Allow</text></g>
<g class="answer"><rect x="${card.x + 14}" y="${card.y + 44}" width="${card.w - 28}" height="44" rx="4" fill="${t.surface2}"/>
<text x="${card.x + 26}" y="${card.y + 71}" class="body" style="font-size:12.5px;fill:${t.ink}">Done: booked Monday 29 at 9:30 AM.</text>
<rect x="${card.x + card.w - 100}" y="${card.y + card.h - 48}" width="86" height="32" rx="4" fill="${t.bg}" stroke="${t.lineStrong}"/><text x="${card.x + card.w - 88}" y="${card.y + card.h - 27}" class="lbl" style="fill:${t.ink}">New task</text></g>
</g>
<g filter="url(#soft)"><circle cx="${fab.x + 22}" cy="${fab.y + 22}" r="22" fill="${t.bg}" stroke="${t.lineStrong}"/></g>
<g transform="translate(${fab.x + 11} ${fab.y + 11}) scale(0.92)" fill="${t.accent}"><ellipse cx="6.5" cy="10" rx="2" ry="2.6"/><ellipse cx="10" cy="6.5" rx="2" ry="2.6"/><ellipse cx="14" cy="6.5" rx="2" ry="2.6"/><ellipse cx="17.5" cy="10" rx="2" ry="2.6"/><path d="M12 11.5c-3 0-5.5 3.4-5.5 5.6 0 1.6 1.3 2.4 2.8 2.4 1.1 0 1.8-.5 2.7-.5s1.6.5 2.7.5c1.5 0 2.8-.8 2.8-2.4 0-2.2-2.5-5.6-5.5-5.6Z"/></g>
<g class="busy"><circle class="spinner" cx="${fab.x + 22}" cy="${fab.y + 22}" r="26" fill="none" stroke="${t.accent}" stroke-width="2" stroke-dasharray="120 44"/></g>
<circle class="ripple" cx="${fab.x + 22}" cy="${fab.y + 22}" r="30" fill="${t.accent}"/>
<circle class="ripple2" cx="${allow.x + 4}" cy="${allow.y + 4}" r="22" fill="${t.accent}"/>
<g class="cursor"><path d="M0 0v17l4.5-4.2 3 6.8 2.6-1.1-3-6.6H13z" fill="${t.ink}" stroke="${t.bg}" stroke-width="1.2" stroke-linejoin="round"/></g>
<rect x="${wx + 32}" y="${wy + wh - 44}" width="${width.label("Alt + Shift + P opens it anywhere") + 28}" height="26" rx="13" fill="${t.surface2}" stroke="${t.lineStrong}"/>
<text x="${wx + 46}" y="${wy + wh - 27}" class="lbl" style="fill:${t.ink2}">Alt + Shift + P opens it anywhere</text>`;
  return doc({
    w: 960, h: 440, t, css, body,
    title: "The page launcher",
    desc: "A floating paw button on a booking page opens a card. The user types 'Book the earliest slot on Monday'; the agent reads the page, clicks Monday, clicks 9:30 AM, asks the user to allow the booking, and reports it done.",
  });
}

// ─── 7. Architecture ────────────────────────────────────────────────────
function architecture(t) {
  const T = 6;
  const node = (x, y, w, h, title, sub, strong = false) => `<g filter="url(#soft)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${strong ? t.accentTint : t.surface}" stroke="${strong ? t.accent : t.lineStrong}"/></g>
<text x="${x + 14}" y="${y + 26}" class="lbl" style="font-size:12px;fill:${strong ? t.accent : t.ink}">${esc(title)}</text>
${sub.map((s, i) => `<text x="${x + 14}" y="${y + 46 + i * 16}" class="body" style="font-size:12px">${esc(s)}</text>`).join("")}`;
  const flow = (d, cls, color = t.accent) => `<path d="${d}" fill="none" stroke="${t.lineStrong}" stroke-width="1.2"/><path class="${cls}" d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="6 18"/>`;
  let css = kf("flow", [[0, "stroke-dashoffset:48"], [100, "stroke-dashoffset:0"]]);
  css += kf("flowBack", [[0, "stroke-dashoffset:0"], [100, "stroke-dashoffset:48"]]);
  css += `.f{animation:flow 1.6s linear infinite}.fb{animation:flowBack 1.6s linear infinite}`;
  css += kf("pulse", [[0, "opacity:.0"], [50, "opacity:.9"], [100, "opacity:0"]]) + `.pulse{animation:pulse ${T / 2}s ease-in-out infinite}`;
  const body = `
<text x="40" y="48" class="lbl">Architecture</text>
<text x="40" y="78" class="title">Everything runs inside Chrome. There is no Pawtrol server.</text>
<rect x="24" y="100" width="640" height="336" rx="10" fill="none" stroke="${t.accent}" stroke-dasharray="6 6" opacity="0.8"/>
<rect x="40" y="90" width="150" height="20" rx="3" fill="${t.bg}"/><text x="48" y="104" class="lbl" style="fill:${t.accent}">Your device · Chrome</text>
${flow("M232 164 C 248 164, 246 244, 262 244", "f")}
${flow("M232 386 C 248 386, 246 312, 262 312", "fb")}
${flow("M432 244 C 446 244, 442 168, 456 168", "f")}
${flow("M456 386 C 442 386, 446 312, 432 312", "f", t.alert)}
${flow("M347 334 V 354", "f", t.ok)}
${flow("M432 268 H 712", "f")}
${flow("M712 290 H 432", "f")}
${node(48, 128, 184, 72, "Side panel · launcher", ["where you give the task", "and approve risky steps"])}
${node(262, 222, 170, 112, "Service worker", ["agent loop and tools", "token vault", "fail-closed send gate"], true)}
<rect class="pulse" x="262" y="222" width="170" height="112" rx="6" fill="none" stroke="${t.accent}" stroke-width="2"/>
${node(48, 350, 184, 72, "Content script", ["reads the page and", "clicks, types, scrolls"])}
${node(456, 128, 184, 72, "Offscreen vision", ["PP-OCRv4 + YuNet on", "WebGPU, then verify"])}
${node(456, 350, 184, 72, "Tripwire", ["catches the page's own", "leaky network calls"])}
${node(262, 354, 170, 64, "Privacy ledger", ["hash chain, counts only"])}
<text x="456" y="260" class="lbl" style="font-size:9.5px;fill:${t.accent}">tokens + verified pixels</text>
<text x="456" y="308" class="lbl" style="font-size:9.5px">tool calls</text>
${node(712, 150, 224, 238, "Model provider", [])}
${["Ollama (on device)", "Anthropic Claude", "OpenAI", "Google Gemini", "Groq", "Cerebras", "NVIDIA NIM", "OpenRouter"]
  .map((p, i) => `<text x="${726}" y="${196 + i * 22}" class="mono" style="font-size:12px;fill:${i === 0 ? t.ok : t.ink2}">${esc(p)}</text>`)
  .join("")}
<text x="712" y="412" class="body" style="font-size:12px">With Ollama, nothing leaves the device.</text>`;
  return doc({
    w: 960, h: 452, t, css, body,
    title: "Architecture",
    desc: "Inside Chrome: the side panel and page launcher, a service worker with the agent loop, token vault and send gate, a content script that reads and acts on the page, an offscreen document that runs on-device vision, a tripwire that watches the page's own network calls, and a hash-chained privacy ledger. Only tokens and verified pixels go to the model provider.",
  });
}

const scenes = { hero, problem, solution, pipeline, vision, launcher, architecture };
mkdirSync(outDir, { recursive: true });
for (const [name, render] of Object.entries(scenes)) {
  for (const [theme, t] of Object.entries(THEMES)) {
    writeFileSync(join(outDir, `${name}-${theme}.svg`), render(t));
  }
}
console.log(`Wrote ${Object.keys(scenes).length * 2} SVGs to ${outDir}`);
