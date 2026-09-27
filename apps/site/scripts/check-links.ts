// Fails the build if any page in dist/ links to a site path that doesn't exist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function exists(urlPath: string): boolean {
  const p = decodeURIComponent(urlPath.split(/[?#]/)[0] ?? "");
  const target = join(DIST, p);
  if (p.endsWith("/")) return existsSync(join(target, "index.html"));
  return (
    existsSync(target) || existsSync(`${target}.html`) || existsSync(join(target, "index.html"))
  );
}

const broken: string[] = [];
let checked = 0;
for (const file of walk(DIST).filter((f) => f.endsWith(".html"))) {
  const html = readFileSync(file, "utf8");
  const page = `/${file.slice(DIST.length + 1).replace(/index\.html$/, "")}`;
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1] as string;
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) continue;
    const abs = url.startsWith("/") ? url : new URL(url, `https://x${page}`).pathname;
    checked++;
    if (!exists(abs)) broken.push(`${page} -> ${url}`);
  }
}
if (broken.length) {
  console.error(`broken links (${broken.length}):\n  ${[...new Set(broken)].join("\n  ")}`);
  process.exit(1);
}
console.log(`links ok (${checked} internal references)`);
