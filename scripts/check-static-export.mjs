import { readFile, stat } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const outputRoot = join(projectRoot, "dist", "client");
const configuredBasePath = (process.argv[2] ?? process.env.NEXT_PUBLIC_BASE_PATH ?? "")
  .trim()
  .replace(/\/$/, "");

function localAssetPath(url, baseDirectory = "") {
  if (/^(?:[a-z]+:|#|data:)/i.test(url)) return null;
  const withoutQuery = url.split(/[?#]/, 1)[0];
  if (configuredBasePath && withoutQuery.startsWith(`${configuredBasePath}/`)) {
    return withoutQuery.slice(configuredBasePath.length + 1);
  }
  if (withoutQuery.startsWith("/")) return withoutQuery.slice(1);
  return posix.normalize(posix.join(baseDirectory, withoutQuery));
}

async function requireFile(relativePath) {
  const root = resolve(outputRoot);
  const absolutePath = resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${sep}`) && absolutePath !== root) {
    throw new Error(`Static reference escapes the export directory: ${relativePath}`);
  }
  const details = await stat(absolutePath);
  if (!details.isFile()) throw new Error(`Expected a file: ${relativePath}`);
}

const indexHtml = await readFile(join(outputRoot, "index.html"), "utf8");
const referencedFiles = new Set();
for (const match of indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  const relativePath = localAssetPath(match[1]);
  if (relativePath) referencedFiles.add(relativePath);
}
for (const relativePath of referencedFiles) await requireFile(relativePath);

for (const cssPath of [...referencedFiles].filter((path) => path.endsWith(".css"))) {
  const css = await readFile(join(outputRoot, cssPath), "utf8");
  for (const match of css.matchAll(/url\((['"]?)([^)'"\s]+)\1\)/g)) {
    const relativePath = localAssetPath(match[2], posix.dirname(cssPath));
    if (relativePath) await requireFile(relativePath);
  }
}

await Promise.all([
  requireFile("data/manifest.json"),
  requireFile("data/airports.json"),
]);
const manifest = JSON.parse(
  await readFile(join(outputRoot, "data", "manifest.json"), "utf8"),
);
if (!manifest.dates?.length || !manifest.chunks?.length) {
  throw new Error("The static data manifest has no dates or flight chunks.");
}
for (const chunk of manifest.chunks) {
  await requireFile(chunk.path.replace(/^\//, ""));
}

console.log(JSON.stringify({
  outputRoot,
  basePath: configuredBasePath || "/",
  referencedAssetCount: referencedFiles.size,
  dates: manifest.dates.length,
  firstDate: manifest.dates[0],
  lastDate: manifest.dates.at(-1),
  chunks: manifest.chunks.length,
  flights: manifest.totals?.flights ?? null,
}, null, 2));
