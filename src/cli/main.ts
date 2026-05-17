#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ExportJob } from "../core/ExportJob.js";
import { StaticPreviewServer } from "../core/StaticPreviewServer.js";
import type { ExportOptions } from "../core/types.js";

type ParsedArgs = {
  readonly command: string | undefined;
  readonly target: string | undefined;
  readonly out: string;
  readonly exportsDir: string;
  readonly maxPages: number | undefined;
  readonly waitMs: number;
  readonly host: string;
  readonly port: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "export" && args.target) {
    await runExport(args);
    return;
  }

  if (args.command === "preview") {
    await runPreview(args);
    return;
  }

  printHelp();
  process.exitCode = args.command ? 1 : 0;
}

async function runExport(args: ParsedArgs): Promise<void> {
  const options = buildExportOptions(args);
  const job = new ExportJob(options);
  const manifest = await job.run();

  console.log(`Exported ${manifest.routes.length} route(s).`);
  console.log(`Saved ${manifest.assets.length} asset(s).`);
  console.log(`Output: ${options.outputDir}`);
  if (manifest.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of manifest.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

async function runPreview(args: ParsedArgs): Promise<void> {
  const rootDir = path.resolve(args.target ?? await chooseExportDirectory(args.exportsDir));
  const server = new StaticPreviewServer({ rootDir, host: args.host, port: args.port });
  const url = await server.start();

  console.log(`Serving: ${rootDir}`);
  console.log(`Preview: ${url}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const stop = async () => {
      await server.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...tokens] = argv;
  let target: string | undefined;
  let out = "exports/site";
  let exportsDir = "exports";
  let maxPages: number | undefined;
  let waitMs = 750;
  let host = "127.0.0.1";
  let port = 4173;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token === "--out" && next) {
      out = next;
      index += 1;
    } else if (token === "--exports-dir" && next) {
      exportsDir = next;
      index += 1;
    } else if (token === "--max-pages" && next) {
      maxPages = parsePositiveInt(next, "--max-pages");
      index += 1;
    } else if (token === "--wait-ms" && next) {
      waitMs = parsePositiveInt(next, "--wait-ms");
      index += 1;
    } else if (token === "--host" && next) {
      host = next;
      index += 1;
    } else if (token === "--port" && next) {
      port = parsePositiveInt(next, "--port");
      index += 1;
    } else if (!token.startsWith("-") && !target) {
      target = token;
    } else {
      throw new Error(`Unknown or incomplete option: ${token}`);
    }
  }

  return { command, target, out, exportsDir, maxPages, waitMs, host, port };
}

type ExportDirectoryChoice = {
  readonly name: string;
  readonly path: string;
  readonly updatedAt: Date;
  readonly routes: number | undefined;
  readonly assets: number | undefined;
};

async function chooseExportDirectory(exportsDir: string): Promise<string> {
  const choices = await discoverExportDirectories(exportsDir);
  if (choices.length === 0) {
    throw new Error(`No export folders found in ${path.resolve(exportsDir)}.`);
  }

  if (choices.length === 1 || !process.stdin.isTTY) {
    return choices[0].path;
  }

  console.log(`Found ${choices.length} export folder(s) in ${path.resolve(exportsDir)}:`);
  choices.forEach((choice, index) => {
    const stats = [choice.routes === undefined ? undefined : `${choice.routes} route(s)`, choice.assets === undefined ? undefined : `${choice.assets} asset(s)`]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${index + 1}. ${choice.name}${stats ? ` (${stats})` : ""}`);
  });

  const rl = createInterface({ input, output });
  try {
    for (;;) {
      const answer = await rl.question("Choose export to preview: ");
      const selected = Number.parseInt(answer.trim(), 10);
      if (Number.isInteger(selected) && selected >= 1 && selected <= choices.length) {
        return choices[selected - 1].path;
      }
      console.log(`Enter a number from 1 to ${choices.length}.`);
    }
  } finally {
    rl.close();
  }
}

async function discoverExportDirectories(exportsDir: string): Promise<ExportDirectoryChoice[]> {
  const rootDir = path.resolve(exportsDir);
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const choices = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => buildExportDirectoryChoice(rootDir, entry.name)),
  );

  return choices
    .filter((choice): choice is ExportDirectoryChoice => choice !== undefined)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}

async function buildExportDirectoryChoice(rootDir: string, name: string): Promise<ExportDirectoryChoice | undefined> {
  const exportPath = path.join(rootDir, name);
  const [directoryStat, manifest] = await Promise.all([stat(exportPath), readManifestSummary(exportPath)]);
  if (!manifest && !(await hasIndexHtml(exportPath))) {
    return undefined;
  }

  return {
    name,
    path: exportPath,
    updatedAt: directoryStat.mtime,
    routes: manifest?.routes,
    assets: manifest?.assets,
  };
}

async function readManifestSummary(exportPath: string): Promise<{ routes: number; assets: number } | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path.join(exportPath, "manifest.json"), "utf8")) as { routes?: unknown[]; assets?: unknown[] };
    return { routes: manifest.routes?.length ?? 0, assets: manifest.assets?.length ?? 0 };
  } catch {
    return undefined;
  }
}

async function hasIndexHtml(exportPath: string): Promise<boolean> {
  try {
    return (await stat(path.join(exportPath, "index.html"))).isFile();
  } catch {
    return false;
  }
}
function buildExportOptions(args: ParsedArgs): ExportOptions {
  if (!args.target) {
    throw new Error("URL is required.");
  }

  const startUrl = new URL(args.target);
  if (!/^https?:$/i.test(startUrl.protocol)) {
    throw new Error("Only public http/https URLs are supported.");
  }

  return {
    startUrl,
    outputDir: path.resolve(args.out),
    maxPages: args.maxPages,
    waitMs: args.waitMs,
  };
}

function parsePositiveInt(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`framexporter\n\nUsage:\n  framexporter export <url> [--out exports/site] [--max-pages N] [--wait-ms 750]\n  framexporter preview [exports/site] [--exports-dir exports] [--host 127.0.0.1] [--port 4173]\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
