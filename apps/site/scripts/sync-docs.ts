// Builds the site's content from the repository's own markdown, so the docs are written once.
// Run before `astro dev` / `astro build`. Output (src/content/docs/, public/images/) is gitignored.
//
// - Repository docs get Starlight frontmatter (title from their first "# " heading, which is
//   removed so it isn't shown twice) and have relative links rewritten to site URLs; links to
//   repository files that aren't published on the site point at the repository on GitHub.
// - Hand-written pages live in src/content-src/ and are copied as-is (links rewritten the same way).
// - Images referenced by the docs are copied to public/images/.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The public repository (not published yet). Links to repo files not on the site go here. */
/**
 * Public repository URL. Empty until the repository is published: links to repo files then
 * render as plain text and the "Source" notes are omitted, so the live site never shows
 * placeholder links. Set it (and src/consts.ts) when the repo goes public.
 */
export const GITHUB_URL = "";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SITE, "../..");
const OUT = join(SITE, "src/content/docs");
const IMAGES_OUT = join(SITE, "public/images");
const HANDWRITTEN = join(SITE, "src/content-src");

interface Source {
  /** Path relative to the repository root. */
  from: string;
  /** Site slug (no leading/trailing slash). */
  slug: string;
  order: number;
  /** Override the title taken from the document's first heading. */
  title?: string;
  description?: string;
}

const SOURCES: Source[] = [
  { from: "README.md", slug: "intro", order: 1, title: "Introduction" },
  {
    from: "docs/cloudflare.md",
    slug: "how-to/deploy-cloudflare",
    order: 1,
    title: "Deploy your own on Cloudflare",
  },
  {
    from: "docs/self-hosting.md",
    slug: "how-to/self-host",
    order: 2,
    title: "Self-host with Docker",
  },
  { from: "docs/architecture.md", slug: "reference/architecture", order: 1 },
  {
    from: "docs/federation.md",
    slug: "reference/federation",
    order: 4,
    title: "Federation: connecting servers",
  },
  { from: "docs/export.md", slug: "reference/export", order: 5, title: "Account export format" },
  { from: "docs/hub.md", slug: "project/hub", order: 4, title: "The public hub" },
  { from: "docs/privacy.md", slug: "project/privacy", order: 5, title: "Privacy and retention" },
  { from: "docs/protocol.md", slug: "reference/protocol", order: 2, title: "Wire protocol" },
  { from: "firmware/README.md", slug: "reference/firmware", order: 3, title: "Firmware" },
  { from: "hardware/README.md", slug: "hardware/overview", order: 1, title: "Hardware overview" },
  { from: "hardware/DESIGN.md", slug: "hardware/design", order: 2, title: "Hardware design" },
  {
    from: "hardware/GUIDELINES.md",
    slug: "hardware/guidelines",
    order: 3,
    title: "Design guidelines",
  },
  { from: "hardware/SCHEMATIC.md", slug: "hardware/schematic", order: 4, title: "Schematic" },
  { from: "hardware/LAYOUT.md", slug: "hardware/layout", order: 5, title: "PCB layout" },
  { from: "hardware/ASSEMBLY.md", slug: "hardware/assembly", order: 6, title: "Assembly" },
  { from: "CONTRIBUTING.md", slug: "project/contributing", order: 2, title: "Contributing" },
];

/** Repo path -> site URL, for every page that will exist. */
function siteMap(sources: Source[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sources) map.set(s.from, `/${s.slug}/`);
  return map;
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;

/**
 * Rewrites a link found in `fromRepoPath` (a repo-relative file) to a site URL.
 * Absolute URLs, anchors and site-absolute paths pass through unchanged.
 */
export function rewriteLink(
  href: string,
  fromRepoPath: string,
  pages: Map<string, string>,
  images: Set<string>,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("/"))
    return href;
  const [path = "", hash = ""] = href.split(/(?=#)/);
  const target = posix.normalize(posix.join(posix.dirname(fromRepoPath), path));
  if (target.startsWith("..")) return href;
  const page = pages.get(target);
  if (page) return page + hash;
  if (IMAGE.test(target) && existsSync(join(REPO, target))) {
    images.add(target);
    return `/images/${basename(target)}`;
  }
  const isDir = existsSync(join(REPO, target)) && statSync(join(REPO, target)).isDirectory();
  if (!GITHUB_URL) return ""; // unpublished repo: caller renders the link text only
  return `${GITHUB_URL}/${isDir ? "tree" : "blob"}/main/${target.replace(/\/$/, "")}${hash}`;
}

function rewriteLinks(
  md: string,
  fromRepoPath: string,
  pages: Map<string, string>,
  images: Set<string>,
) {
  // Skip fenced code blocks so example code isn't touched.
  return md
    .split(/(^```[\s\S]*?^```)/m)
    .map((chunk, i) =>
      i % 2 === 1
        ? chunk
        : chunk
            .replace(
              /(!?\[([^\]]*)\]\()([^)\s]+)(\s+"[^"]*")?\)/g,
              (_m, pre, text, href, title = "") => {
                const to = rewriteLink(href, fromRepoPath, pages, images);
                return to ? `${pre}${to}${title})` : text;
              },
            )
            .replace(
              /(<img[^>]*\ssrc=")([^"]+)(")/g,
              (_m, pre, src, post) =>
                `${pre}${rewriteLink(src, fromRepoPath, pages, images)}${post}`,
            ),
    )
    .join("");
}

const yamlString = (s: string) => JSON.stringify(s);

/** Splits off the first "# Title" line (and returns the rest). */
export function takeTitle(md: string): { title?: string; body: string } {
  const m = /^\s*#\s+(.+?)\s*\n/.exec(md);
  if (!m) return { body: md };
  return { title: m[1], body: md.slice(m[0].length) };
}

/** First plain paragraph, as a meta description. */
export function firstParagraph(md: string): string | undefined {
  for (const block of md.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^[#|<`>!\-*\d]/.test(t) || t.startsWith("```")) continue;
    return t
      .replace(/\s+/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .slice(0, 200);
  }
  return undefined;
}

function write(slug: string, content: string) {
  const file = join(OUT, `${slug}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function sync(): { pages: number; images: number; skipped: string[] } {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(IMAGES_OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const present = SOURCES.filter((s) => existsSync(join(REPO, s.from)));
  const skipped = SOURCES.filter((s) => !present.includes(s)).map((s) => s.from);
  const handwritten = walk(HANDWRITTEN).filter((p) => /\.mdx?$/.test(p));
  const pages = siteMap(present);
  // Hand-written pages can be linked from repo docs by their content-src path.
  for (const p of handwritten) {
    const slug = relative(HANDWRITTEN, p)
      .replace(/\.mdx?$/, "")
      .replace(/(^|\/)index$/, "");
    pages.set(`apps/site/src/content-src/${relative(HANDWRITTEN, p)}`, slug ? `/${slug}/` : "/");
  }
  const images = new Set<string>();

  for (const s of present) {
    const raw = readFileSync(join(REPO, s.from), "utf8").replace(/^<!--.*?-->\s*/s, "");
    const { title, body } = takeTitle(raw);
    const description = s.description ?? firstParagraph(body);
    const front = [
      "---",
      `title: ${yamlString(s.title ?? title ?? s.slug)}`,
      ...(description ? [`description: ${yamlString(description)}`] : []),
      "sidebar:",
      `  order: ${s.order}`,
      "editUrl: false",
      "---",
      "",
      GITHUB_URL
        ? `:::note[Source]\nThis page is generated from [\`${s.from}\`](${GITHUB_URL}/blob/main/${s.from}) in the repository.\n:::`
        : `:::note[Source]\nThis page is generated from \`${s.from}\` in the project repository.\n:::`,
      "",
    ].join("\n");
    write(s.slug, front + rewriteLinks(body, s.from, pages, images));
  }

  // Pages whose source document doesn't exist yet: links to them become plain text.
  const missing = SOURCES.filter((m) => skipped.includes(m.from)).map((m) => `/${m.slug}/`);
  for (const p of handwritten) {
    const rel = relative(HANDWRITTEN, p);
    const repoPath = `apps/site/src/content-src/${rel}`;
    let content = rewriteLinks(readFileSync(p, "utf8"), repoPath, pages, images);
    for (const url of missing) {
      content = content.replaceAll(
        new RegExp(`\\[([^\\]]+)\\]\\(${url.replace(/[/-]/g, "\\$&")}\\)`, "g"),
        "$1 (coming soon)",
      );
    }
    const target = join(OUT, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  mkdirSync(IMAGES_OUT, { recursive: true });
  for (const img of images) cpSync(join(REPO, img), join(IMAGES_OUT, basename(img)));
  // Screenshots used by hand-written pages via /images/…
  for (const f of walk(join(REPO, "docs/images"))) cpSync(f, join(IMAGES_OUT, basename(f)));
  // One icon for the whole project: the companion's is the source of truth.
  const icon = join(REPO, "apps/companion/public/icon.svg");
  cpSync(icon, join(SITE, "src/logo.svg"));
  cpSync(icon, join(SITE, "public/favicon.svg"));

  return { pages: present.length + handwritten.length, images: images.size, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = sync();
  console.log(
    `synced ${r.pages} pages, ${r.images} referenced images` +
      (r.skipped.length ? `; skipped missing: ${r.skipped.join(", ")}` : ""),
  );
}
