import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { extname, resolve, sep } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const staticRoot = resolve(projectRoot, "dist", "client");
const port = Number(process.env.PORT ?? 4173);
const shouldOpenBrowser = process.argv.includes("--open");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const relativePath = decodedPath === "/"
      ? "index.html"
      : decodedPath.replace(/^\/+/, "");
    let absolutePath = resolve(staticRoot, relativePath);
    if (!absolutePath.startsWith(`${staticRoot}${sep}`) && absolutePath !== staticRoot) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const details = await stat(absolutePath);
    if (details.isDirectory()) absolutePath = resolve(absolutePath, "index.html");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentTypes[extname(absolutePath)] ?? "application/octet-stream",
    });
    createReadStream(absolutePath).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

function openDefaultBrowser(url) {
  const command = process.platform === "win32"
    ? { executable: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
    : process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Aircraft Delay Visualizer: ${url}`);
  console.log("Keep this window open while using the site. Press Ctrl+C to stop.");
  if (shouldOpenBrowser) openDefaultBrowser(url);
});
