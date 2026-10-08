#!/usr/bin/env bun
import pkg from "../package.json";
import { runConfigCommand } from "./commands/config.ts";
import { runDevCommand } from "./commands/dev.ts";
import { runDoctorCommand } from "./commands/doctor.ts";
import { runExportCommand } from "./commands/export.ts";
import { runHealthcheck } from "./commands/healthcheck.ts";
import { runInitCommand } from "./commands/init.ts";
import { runInjectCommand } from "./commands/inject.ts";
import { runProjectCommand } from "./commands/project.ts";
import { runServeCommand } from "./commands/serve.ts";
import { runStartCommand } from "./commands/start.ts";
import { runTokenCommand } from "./commands/token.ts";

// Releases inline the tag's version with `bun build --define`; from source it is the package version.
const version = process.env.NOTATO_VERSION ?? pkg.version;

const HELP = `notato ${version}

Usage: notato [command] [options]

With no command, runs \`notato start\`: the server, the board and MCP for your agents, until you stop it.

Commands:
  start     Run Notato on this machine: the board, and MCP for any coding agent at /mcp (the default)
  init      Set up Notato in this React app and in your coding agents (Claude Code, Codex, Cursor…)
  inject    Put Notato on any page with a bookmark, no install in the app
  config    Show or change settings, such as turning screenshots off
  export    Print annotations as Markdown, at the level of detail you choose
  doctor    Check the whole loop: server, a real annotation end to end, browser, your agents
  dev       Run the local server and speak MCP over stdio (what an agent starts for itself)
  serve     Run the shared server: login, project tokens, HTTP API, MCP over HTTP, board UI
  project   Create, list, rename and delete projects (a shared server only takes notes for its projects)
  token     Create, list and revoke project tokens

Options:
  -h, --help       Show this help
  -v, --version    Show the version

Run \`notato <command> --help\` for a command's options.`;

const HELP_FLAGS = new Set(["-h", "--help", "help"]);
const VERSION_FLAGS = new Set(["-v", "--version", "version"]);

/** `npx notato`, or `npx notato --port 4800`: no command means start the server. */
const startsServer = (command: string | undefined) =>
    command === undefined ||
    (command.startsWith("-") && !HELP_FLAGS.has(command) && !VERSION_FLAGS.has(command));

export async function main(argv: string[]): Promise<number> {
    const [command, ...rest] = argv;
    if (HELP_FLAGS.has(command ?? "")) {
        console.log(HELP);
        return 0;
    }
    if (VERSION_FLAGS.has(command ?? "")) {
        console.log(version);
        return 0;
    }
    try {
        if (startsServer(command)) return await runStartCommand(argv, version);
        if (command === "healthcheck") return await runHealthcheck();
        if (command === "start") return await runStartCommand(rest, version);
        if (command === "init") return await runInitCommand(rest);
        if (command === "inject") return await runInjectCommand(rest);
        if (command === "config") return await runConfigCommand(rest);
        if (command === "export") return await runExportCommand(rest);
        if (command === "doctor") return await runDoctorCommand(rest);
        if (command === "dev") return await runDevCommand(rest, version);
        if (command === "serve") return await runServeCommand(rest, version);
        if (command === "project") return await runProjectCommand(rest);
        if (command === "token") return await runTokenCommand(rest);
    } catch (error) {
        // stdout belongs to the MCP protocol in `dev`, so every message goes to stderr.
        console.error(`notato: ${error instanceof Error ? error.message : error}`);
        return 1;
    }
    console.error(`notato: unknown command "${command}"\n\n${HELP}`);
    return 2;
}

if (import.meta.main) {
    const code = await main(process.argv.slice(2));
    // `start`, `dev` and `serve` keep running on their open server; any other command is done here.
    const command = process.argv[2];
    const longRunning =
        command === "dev" ||
        ((startsServer(command) || command === "start" || command === "serve") &&
            !process.argv.includes("--help") &&
            !process.argv.includes("-h"));
    if (code !== 0 || !longRunning) process.exit(code);
}
