#!/usr/bin/env bun
import { main as openMain } from "@notato/cli";
import pkg from "../package.json";
import { runHealthcheck } from "./healthcheck.ts";
import { runPreflightCommand } from "./preflight.ts";
import { runCloudServeCommand } from "./serve.ts";

const HELP = `notato-server ${pkg.version}

The self-hosted Notato service, and the commands it is run and checked with. Every other \`notato\` command that works
against a server (doctor, init, inject, export, config) works here as it does there.

Commands:
  serve        Run the service: accounts, workspaces, integrations and the API, on Postgres
  preflight    Check the deployment's configuration offline, without printing secrets
  healthcheck  Exit 0 when the service on this machine is ready (for a container's health check)

Run \`notato-server serve --help\` for the service's options.`;

/** Commands that work on a local data folder: the full server keeps its records in Postgres, so they do not apply. */
const LOCAL_ONLY = new Set([
    "start",
    "dev",
    "project",
    "token",
    "backup",
    "restore",
    "backup-keygen",
    "backup-healthcheck",
]);

export async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (!command || command === "-h" || command === "--help") {
        console.log(HELP);
        return command ? 0 : 1;
    }
    if (command === "-v" || command === "--version") {
        console.log(pkg.version);
        return 0;
    }
    try {
        if (command === "serve") return await runCloudServeCommand(rest, pkg.version);
        if (command === "preflight") return await runPreflightCommand(rest);
        if (command === "healthcheck") return await runHealthcheck();
    } catch (error) {
        console.error(`notato-server: ${error instanceof Error ? error.message : error}`);
        return 1;
    }
    if (LOCAL_ONLY.has(command)) {
        console.error(
            `notato-server: "${command}" works on a local data folder, and the full server keeps its records in Postgres`
        );
        return 2;
    }
    return openMain(argv);
}

if (import.meta.main) {
    const code = await main(process.argv.slice(2));
    // `serve` keeps running on its open server; any other command is done here.
    const longRunning =
        process.argv[2] === "serve" &&
        !process.argv.includes("--help") &&
        !process.argv.includes("-h");
    if (code !== 0 || !longRunning) process.exit(code);
}
