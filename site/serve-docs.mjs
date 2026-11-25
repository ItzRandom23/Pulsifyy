import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const host = "127.0.0.1";
const siteDirectory = new URL("./", import.meta.url);
const publicDirectory = new URL("public/", siteDirectory);
const indexFile = new URL("index.html", siteDirectory);
const assets = new Map([["quickstart.webp", "image/webp"]]);

const idAttribute = /(?:^|\s)id\s*=\s*(["'])([a-z0-9]+(?:-[a-z0-9]+)*)\1/i;

function discoverRoutes(page) {
  const routes = new Set();
  for (const [, attributes, content] of page.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const articleId = attributes.match(idAttribute)?.[2];
    if (!articleId) continue;
    const articlePath = `/${articleId}`;
    routes.add(articlePath);

    for (const [, headingAttributes] of content.matchAll(/<h2\b([^>]*)>/gi)) {
      const headingId = headingAttributes.match(idAttribute)?.[2];
      if (!headingId) continue;
      const prefix = `${articleId}-`;
      const section = headingId.startsWith(prefix) ? headingId.slice(prefix.length) : headingId;
      routes.add(`${articlePath}/${section}`);
    }
  }
  return routes;
}

async function buildStaticRoutes() {
  const page = await readFile(indexFile, "utf8");
  const routes = discoverRoutes(page);
  await mkdir(publicDirectory, { recursive: true });
  await copyFile(indexFile, new URL("index.html", publicDirectory));
  for (const asset of assets.keys()) {
    await copyFile(new URL(asset, siteDirectory), new URL(asset, publicDirectory));
  }
  for (const route of routes) {
    const directory = new URL(`.${route}/`, publicDirectory);
    await mkdir(directory, { recursive: true });
    await writeFile(new URL("index.html", directory), page);
  }
  console.log(`Generated ${routes.size} static documentation routes in site/public with Node.js ${process.version}.`);
}

const server = createServer(async (request, response) => {
  function send(status, contentType, content, headers) {
    response.writeHead(status, {
      "Content-Type": contentType,
      "Content-Length": Buffer.byteLength(content),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    response.end(request.method === "HEAD" ? undefined : content);
  }

  const plainText = "text/plain; charset=utf-8";
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(405, plainText, "Method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const pathname = request.url?.split("?", 1)[0];
  if (!pathname?.startsWith("/")) {
    send(400, plainText, "Bad request\n");
    return;
  }

  try {
    const asset = pathname.slice(1);
    const contentType = assets.get(asset);
    if (contentType) {
      send(200, contentType, await readFile(new URL(asset, siteDirectory)));
      return;
    }
    const page = await readFile(indexFile, "utf8");
    const route = pathname.endsWith("//") ? pathname : pathname.replace(/(.)\/$/, "$1");
    if (route === "/" || route === "/index.html" || discoverRoutes(page).has(route)) {
      send(200, "text/html; charset=utf-8", page);
      return;
    }
    send(404, plainText, "Not found\n");
  } catch (error) {
    if (error.code === "ENOENT") {
      send(404, plainText, "Not found\n");
      return;
    }
    console.error(error);
    send(500, plainText, "Could not serve the documentation\n");
  }
});

function announceServer() {
  console.log(`Pulsifyy documentation: http://${host}:${server.address().port}/`);
}

const option = process.argv[2];
if (option === "--static") {
  await buildStaticRoutes();
} else {
  const port = Number(option ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("Pass a valid port with npm run docs -- <port>.");
  }

  server.once("error", error => {
    if (error.code !== "EADDRINUSE" || option !== undefined) throw error;
    console.log(`Port ${port} is already in use. Starting the docs on an available port.`);
    server.listen(0, host);
  });
  server.once("listening", announceServer);
  server.listen(port, host);
}
