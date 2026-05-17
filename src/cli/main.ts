#!/usr/bin/env node
import path from "node:path";
import { ExportJob } from "../core/ExportJob.js";
import { StaticPreviewServer } from "../core/StaticPreviewServer.js";
import type { ExportOptions } from "../core/types.js";

type ParsedArgs = {
  readonly command: string | undefined;
  readonly target: string | undefined;
  readonly out: string;
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
  const rootDir = path.resolve(args.target ?? args.out);
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
  const [command, target, ...rest] = argv;
  let out = "exports/site";
  let maxPages: number | undefined;
  let waitMs = 750;
  let host = "127.0.0.1";
  let port = 4173;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    const next = rest[index + 1];
    if (token === "--out" && next) {
      out = next;
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
    } else {
      throw new Error(`Unknown or incomplete option: ${token}`);
    }
  }

  return { command, target, out, maxPages, waitMs, host, port };
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
  console.log(`framexporter\n\nUsage:\n  framexporter export <url> [--out exports/site] [--max-pages N] [--wait-ms 750]\n  framexporter preview [exports/site] [--host 127.0.0.1] [--port 4173]\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
