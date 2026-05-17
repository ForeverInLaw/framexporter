#!/usr/bin/env node
import path from "node:path";
import { ExportJob } from "../core/ExportJob.js";
import type { ExportOptions } from "../core/types.js";

type ParsedArgs = {
  readonly command: string | undefined;
  readonly url: string | undefined;
  readonly out: string;
  readonly maxPages: number | undefined;
  readonly waitMs: number;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== "export" || !args.url) {
    printHelp();
    process.exitCode = args.command ? 1 : 0;
    return;
  }

  const options = buildOptions(args);
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

function parseArgs(argv: string[]): ParsedArgs {
  const [command, url, ...rest] = argv;
  let out = "exports/site";
  let maxPages: number | undefined;
  let waitMs = 750;

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
    } else {
      throw new Error(`Unknown or incomplete option: ${token}`);
    }
  }

  return { command, url, out, maxPages, waitMs };
}

function buildOptions(args: ParsedArgs): ExportOptions {
  if (!args.url) {
    throw new Error("URL is required.");
  }

  const startUrl = new URL(args.url);
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
  console.log(`framexporter\n\nUsage:\n  framexporter export <url> [--out exports/site] [--max-pages N] [--wait-ms 750]\n`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
