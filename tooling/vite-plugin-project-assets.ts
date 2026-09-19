/**
 * Vite plugin: expose a project directory outside `public/` as static files, and accept
 * benchmark results from the browser.
 *
 * - GET  <urlPrefix>/<path>  -> <dir>/<path> in dev; the directory is copied to
 *   dist/<urlPrefix> on build.
 * - POST /__bench/record     -> writes the JSON body to <benchDir>/<name>-<timestamp>.json
 *   (dev only) so benchmark runs land in the repo without a manual download.
 */

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, cpSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Plugin } from "vite";

const MIME: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ktx2": "image/ktx2",
  ".bin": "application/octet-stream",
};

export interface ProjectAssetsOptions {
  urlPrefix: string;
  dir: string;
  benchDir?: string;
}

export function projectAssets(opts: ProjectAssetsOptions): Plugin {
  const root = resolve(opts.dir);
  const prefix = opts.urlPrefix.replace(/\/$/, "");
  const benchDir = opts.benchDir === undefined ? null : resolve(opts.benchDir);
  let outDir = "dist";

  return {
    name: "project-assets",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";

        if (benchDir !== null && req.method === "POST" && url === "/__bench/record") {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { name?: string };
              const name = (body.name ?? "run").replace(/[^a-z0-9_-]/gi, "_");
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const dir = benchDir;
              mkdirSync(dir, { recursive: true });
              const file = join(dir, `${name}-${stamp}.json`);
              writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, file }));
            } catch (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
            }
          });
          return;
        }

        if (req.method !== "GET" || !url.startsWith(prefix + "/")) {
          next();
          return;
        }
        const rel = normalize(decodeURIComponent(url.slice(prefix.length + 1)));
        if (rel.startsWith("..") || rel.includes(`${sep}..`)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const file = join(root, rel);
        if (!existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end(`not found: ${url}`);
          return;
        }
        res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
        res.setHeader("Content-Length", String(statSync(file).size));
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (existsSync(root)) {
        cpSync(root, join(resolve(outDir), prefix.replace(/^\//, "")), { recursive: true });
      }
    },
  };
}
