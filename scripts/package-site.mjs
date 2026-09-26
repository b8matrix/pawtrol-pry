// Builds the extension, zips dist/ into site/pawtrol-extension.zip, and
// stamps the version and size into site/index.html. Run: npm run site
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const site = join(root, "site");
const zipPath = join(site, "pawtrol-extension.zip");

if (!process.argv.includes("--no-build")) execSync("npm run build", { cwd: root, stdio: "inherit" });

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

// Source maps are for development only; users don't need them.
const files = walk(dist).filter((f) => !f.endsWith(".map")).sort();

// Minimal ZIP writer (deflate, no dependencies). Everything goes under a
// top-level "pawtrol/" folder so "Load unpacked" has an obvious target.
const local = [];
const central = [];
let offset = 0;
const dosTime = (() => {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
})();

for (const file of files) {
  const name = Buffer.from("pawtrol/" + relative(dist, file).split(sep).join("/"));
  const raw = readFileSync(file);
  const packed = deflateRawSync(raw, { level: 9 });
  const stored = packed.length >= raw.length;
  const body = stored ? raw : packed;
  const crc = crc32(raw);

  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(stored ? 0 : 8, 8);
  head.writeUInt16LE(dosTime.time, 10);
  head.writeUInt16LE(dosTime.date, 12);
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(body.length, 18);
  head.writeUInt32LE(raw.length, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  local.push(head, name, body);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(stored ? 0 : 8, 10);
  cen.writeUInt16LE(dosTime.time, 12);
  cen.writeUInt16LE(dosTime.date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(raw.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(offset, 42);
  central.push(cen, name);

  offset += head.length + name.length + body.length;
}

const cenSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cenSize, 12);
end.writeUInt32LE(offset, 16);

writeFileSync(zipPath, Buffer.concat([...local, ...central, end]));

mkdirSync(join(site, "assets"), { recursive: true });
for (const icon of ["icon48.png", "icon128.png"]) copyFileSync(join(root, "icons", icon), join(site, "assets", icon));

const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const mb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
const meta = `Version ${version} · ZIP · ${mb} MB`;
const htmlPath = join(site, "index.html");
const html = readFileSync(htmlPath, "utf8").replace(/<!--zip-meta-->[\s\S]*?<!--\/zip-meta-->/g, `<!--zip-meta-->${meta}<!--/zip-meta-->`);
writeFileSync(htmlPath, html);

console.log(`site/pawtrol-extension.zip: ${files.length} files, ${mb} MB (${meta})`);
