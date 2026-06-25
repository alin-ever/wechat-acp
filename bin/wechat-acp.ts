#!/usr/bin/env node

/**
 * wechat-acp CLI entry point.
 *
 * Usage:
 *   wechat-acp --agent "claude code"
 *   wechat-acp --agent "gemini" --cwd /path/to/project
 *   wechat-acp --agent "npx tsx ./agent.ts" --login
 *   wechat-acp --agent "claude code" --daemon
 *   wechat-acp list
 *   wechat-acp stop
 *   wechat-acp restart
 *   wechat-acp status
 *   wechat-acp inject --text "今日 AI 资讯"
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";
import { WeChatAcpBridge } from "../src/bridge.js";
import {
  defaultConfig,
  defaultStorageDir,
  listBuiltInAgents,
  resolveAgentSelection,
  validateCommandAliases,
  validateInstanceName,
} from "../src/config.js";
import type { WeChatAcpConfig } from "../src/config.js";
import { queueInjectedMessage } from "../src/inject/queue.js";
import { DEFAULT_INJECTION_TARGET } from "../src/inject/types.js";
import {
  initTelemetry,
  trackEvent,
  trackException,
  shutdownTelemetry,
} from "../src/telemetry/index.js";
import packageJson from "../package.json" with { type: "json" };

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function usage(): void {
  const presets = listBuiltInAgents()
    .map(({ id }) => id)
    .join(", ");

  console.log(`
wechat-acp v${packageJson.version} — Bridge WeChat to any ACP-compatible AI agent

Usage:
  wechat-acp --agent <preset|command>  [options]
  wechat-acp agents                        List built-in agent presets
  wechat-acp list                          List all running daemon instances
  wechat-acp inject --text <text>          Inject a local message into the daemon
  wechat-acp stop                          Stop a running daemon
  wechat-acp restart                       Restart a running daemon
  wechat-acp status                        Check daemon status

Options:
  --agent <value>     Built-in preset name or raw agent command
                      Presets: ${presets}
                      Examples: "copilot", "claude", "npx tsx ./agent.ts"
  --cwd <dir>         Working directory for agent (default: current dir)
  --login             Force re-login (new QR code)
  --daemon            Run in background after login
  --config <file>     Config file path (JSON)
  --instance <name>   Run as a named, isolated instance.
                      Storage, token, daemon pid/log, and telemetry id are
                      scoped to ~/.wechat-acp/instances/<name>/.
                      Lets you run multiple bridges side by side, each with
                      its own WeChat account and project cwd.
  --inbox-dir <path>  Directory to save binary files received from WeChat
                      (default: <storage.dir>/inbox). The agent sees the
                      saved absolute path in the prompt so it can read the
                      file directly.
  --no-inbox          Disable saving received files. The agent will only
                      see a "[Received file: name, N bytes]" notice and
                      will not be able to read the file content.
  --idle-timeout <m>  Session idle timeout in minutes (default: 1440)
                      Use 0 to disable idle cleanup
  --max-sessions <n>  Max concurrent user sessions (default: 10)
  --hide-thoughts     Do not forward agent thinking to WeChat (default: forwarded)
  --show-diffs        Forward ACP file diffs to WeChat (default: hidden)
  --text <text>       Message text for "inject"
  --file <path>       Read injected message text from a file
  --to <target>       Injection target (default: ${DEFAULT_INJECTION_TARGET})
  --context-token <t> Override stored context token for "inject"
  -v, --verbose       Verbose logging
  -V, --version       Print version and exit
  -h, --help          Show this help
`);
}

async function handleInject(
  config: WeChatAcpConfig,
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  if (!config.storage.injectDir) {
    throw new Error("storage.injectDir is not configured");
  }
  if (!args.injectText && !args.injectFile) {
    throw new Error('inject requires --text <text> or --file <path>');
  }
  if (args.injectText && args.injectFile) {
    throw new Error("inject accepts only one of --text or --file");
  }

  const text = args.injectFile
    ? fs.readFileSync(path.resolve(args.injectFile), "utf-8")
    : args.injectText!;

  const { job, filePath } = await queueInjectedMessage({
    injectDir: config.storage.injectDir,
    text,
    target: args.injectTo,
    contextToken: args.injectContextToken,
  });

  console.log(`Queued injection ${job.id}`);
  console.log(`Target: ${job.target}`);
  console.log(`File: ${filePath}`);
  console.log("It will be processed by any running wechat-acp instance using the same storage directory.");
}

function parseArgs(argv: string[]): {
  command?: string;
  agent?: string;
  cwd?: string;
  forceLogin: boolean;
  daemon: boolean;
  configFile?: string;
  instance?: string;
  inboxDir?: string;
  disableInbox: boolean;
  idleTimeout?: number;
  maxSessions?: number;
  injectText?: string;
  injectFile?: string;
  injectTo?: string;
  injectContextToken?: string;
  hideThoughts: boolean;
  showDiffs: boolean;
  verbose: boolean;
  version: boolean;
  help: boolean;
} {
  const result = {
    forceLogin: false,
    daemon: false,
    disableInbox: false,
    hideThoughts: false,
    showDiffs: false,
    verbose: false,
    version: false,
    help: false,
  } as ReturnType<typeof parseArgs>;

  const args = argv.slice(2);
  let i = 0;

  // Check for subcommand
  if (args[0] && !args[0].startsWith("-")) {
    result.command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--agent":
        result.agent = args[++i];
        break;
      case "--cwd":
        result.cwd = args[++i];
        break;
      case "--login":
        result.forceLogin = true;
        break;
      case "--daemon":
        result.daemon = true;
        break;
      case "--config":
        result.configFile = args[++i];
        break;
      case "--instance":
        result.instance = args[++i];
        break;
      case "--inbox-dir":
        result.inboxDir = args[++i];
        break;
      case "--no-inbox":
        result.disableInbox = true;
        break;
      case "--idle-timeout":
        result.idleTimeout = parseInt(args[++i], 10);
        break;
      case "--max-sessions":
        result.maxSessions = parseInt(args[++i], 10);
        break;
      case "--text":
        result.injectText = args[++i];
        break;
      case "--file":
        result.injectFile = args[++i];
        break;
      case "--to":
        result.injectTo = args[++i];
        break;
      case "--context-token":
        result.injectContextToken = args[++i];
        break;
      case "--hide-thoughts":
        result.hideThoughts = true;
        break;
      case "--show-diffs":
        result.showDiffs = true;
        break;
      case "-v":
      case "--verbose":
        result.verbose = true;
        break;
      case "-V":
      case "--version":
        result.version = true;
        break;
      case "-h":
      case "--help":
        result.help = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
    i++;
  }

  return result;
}

function loadConfigFile(filePath: string): Partial<WeChatAcpConfig> {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content) as Partial<WeChatAcpConfig>;
}

function handleAgents(config: WeChatAcpConfig): void {
  console.log("Built-in ACP agent presets:\n");
  for (const { id, preset } of listBuiltInAgents(config.agents)) {
    const commandLine = [preset.command, ...preset.args].join(" ");
    console.log(`${id.padEnd(10)} ${commandLine}`);
    if (preset.description) {
      console.log(`           ${preset.description}`);
    }
  }
}

function handleStop(config: WeChatAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("No daemon running (no PID file found)");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    fs.unlinkSync(pidFile);
    console.log(`Stopped daemon (PID ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      fs.unlinkSync(pidFile);
      console.log(`Daemon not running (stale PID ${pid}), cleaned up`);
    } else {
      console.error(`Failed to stop daemon: ${String(err)}`);
    }
  }
}

function handleStatus(config: WeChatAcpConfig): void {
  const pidFile = config.daemon.pidFile;
  if (!fs.existsSync(pidFile)) {
    console.log("Not running");
    return;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0); // test if process exists
    console.log(`Running (PID ${pid})`);
  } catch {
    console.log(`Not running (stale PID ${pid})`);
    fs.unlinkSync(pidFile);
  }
}

function handleList(config: WeChatAcpConfig): void {
  const instances: Array<{
    name: string;
    pid: number;
    pidFile: string;
    argsFile: string;
    agentLabel: string;
  }> = [];

  const baseDir = config.storage.instance
    ? defaultStorageDir(config.storage.instance)
    : defaultStorageDir();
  const parentDir = path.dirname(baseDir);

  // Default instance
  const defaultPidFile = path.join(defaultStorageDir(), "daemon.pid");
  if (fs.existsSync(defaultPidFile)) {
    const pid = readPidSafely(defaultPidFile);
    if (pid !== null) {
      const isAlive = processExists(pid);
      instances.push({
        name: isAlive ? "default" : "default (stale)",
        pid,
        pidFile: defaultPidFile,
        argsFile: path.join(defaultStorageDir(), "daemon.args"),
        agentLabel: readAgentLabel(path.join(defaultStorageDir(), "daemon.args")),
      });
    }
  }

  // Named instances
  const instancesDir = path.join(parentDir, "instances");
  if (fs.existsSync(instancesDir)) {
    for (const entry of fs.readdirSync(instancesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      const pidFile = path.join(instancesDir, name, "daemon.pid");
      if (!fs.existsSync(pidFile)) continue;

      const pid = readPidSafely(pidFile);
      if (pid === null) continue;

      const isAlive = processExists(pid);
      instances.push({
        name: isAlive ? name : `${name} (stale)`,
        pid,
        pidFile,
        argsFile: path.join(instancesDir, name, "daemon.args"),
        agentLabel: readAgentLabel(path.join(instancesDir, name, "daemon.args")),
      });
    }
  }

  if (instances.length === 0) {
    console.log("No instances found.");
    return;
  }

  const isDaemonMode = process.env.WECHAT_ACP_DAEMON === "1";
  if (isDaemonMode) {
    console.log("⚠️  list is not available inside the daemon process.");
    console.log("Run wechat-acp list directly (not via the daemon).");
    return;
  }

  for (const inst of instances) {
    const alive = !inst.name.includes("(stale)");
    const status = alive ? "\x1b[32mRunning\x1b[0m" : "\x1b[31mDead\x1b[0m";
    let line = `${inst.name.padEnd(16)} ${status} (PID ${inst.pid})`;
    if (inst.agentLabel) line += `  agent: ${inst.agentLabel}`;
    console.log(line);
  }
}

function readPidSafely(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!pid || !Number.isFinite(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readAgentLabel(argsFile: string): string {
  try {
    const raw = fs.readFileSync(argsFile, "utf-8");
    const saved = JSON.parse(raw);
    if (saved.agent) return saved.agent;
    // Try to extract from argv
    const argv = saved.argv ?? [];
    const idx = argv.findIndex((a: string) => a === "--agent");
    if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
    return "";
  } catch {
    return "";
  }
}

async function handleRestart(
  config: WeChatAcpConfig,
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const pidFile = config.daemon.pidFile;
  const argsFile = path.join(path.dirname(pidFile), "daemon.args");

  if (!fs.existsSync(pidFile)) {
    console.log("No daemon running (no PID file found).");
    console.log('Use "wechat-acp --agent <preset> --daemon" to start one.');
    return;
  }

  // Read the saved args to rebuild the command line
  let savedAgent: string | null = null;
  let savedArgs: string[] = [];
  let savedCwd: string | undefined;
  let savedConfigFile: string | undefined;
  let savedInstance: string | undefined;
  try {
    if (fs.existsSync(argsFile)) {
      const raw = fs.readFileSync(argsFile, "utf-8");
      const saved = JSON.parse(raw);
      savedAgent = saved.agent ?? null;
      savedArgs = saved.argv ?? [];
      if (savedArgs.length > 0) {
        const sp = parseArgs(savedArgs);
        savedCwd = sp.cwd;
        savedConfigFile = sp.configFile;
        savedInstance = sp.instance;
      }
    }
  } catch {
    // fallback: try to use the CLI --agent argument
  }

  // Stop first
  const pid = readPidSafely(pidFile);
  if (pid !== null && processExists(pid)) {
    console.log(`Stopping daemon (PID ${pid})...`);
    process.kill(pid, "SIGTERM");

    // Wait for process to exit
    const deadline = Date.now() + 10_000;
    while (processExists(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (processExists(pid)) {
      console.error("Daemon did not exit within 10 seconds, force killing...");
      process.kill(pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`Stopped daemon (PID ${pid})`);
  } else {
    console.log("Daemon not running (stale PID), cleaned up.");
  }

  // Clean up PID file
  try { fs.unlinkSync(pidFile); } catch { /* ok */ }

  const agentSelection = args.agent ?? savedAgent ?? config.agent.preset;
  if (!agentSelection) {
    console.error("Error: could not determine agent from saved state. Provide --agent explicitly.");
    process.exit(1);
  }

  console.log(`Restarting with agent: ${agentSelection}...`);

  // Build restart args
  const restartArgs = [
    "--agent", agentSelection,
    "--daemon",
  ];
  const cwd = args.cwd ?? savedCwd;
  if (cwd) restartArgs.push("--cwd", cwd);
  const cfgFile = args.configFile ?? savedConfigFile;
  if (cfgFile) restartArgs.push("--config", cfgFile);
  const inst = args.instance ?? savedInstance;
  if (inst) restartArgs.push("--instance", inst);

  daemonize(config, {
    agent: agentSelection,
    argv: restartArgs,
  });

  // Small delay so daemon's PID file is written before we return
  await new Promise((r) => setTimeout(r, 500));
  const newPid = readPidSafely(pidFile);
  if (newPid) {
    console.log(`Restarted (PID ${newPid})`);
  }
}
  function daemonize(
  config: WeChatAcpConfig,
  meta?: { agent?: string; argv?: string[] },
): void {
  const logFile = config.daemon.logFile;
  const pidFile = config.daemon.pidFile;

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  // Store metadata for future restarts
  if (meta) {
    const argsFile = path.join(path.dirname(pidFile), "daemon.args");
    fs.writeFileSync(argsFile, JSON.stringify(meta, null, 2), "utf-8");
  }

  // Re-run ourselves as a detached child process.
  // Preserve the original node flags (e.g. --import tsx/esm) so that
  // TypeScript ESM imports continue to resolve in the child.
  const childArgs = meta && meta.argv
    ? [
        ...process.execArgv,
        process.argv[1],
        ...meta.argv.filter((a) => a !== "--daemon"),
      ]
    : [
        ...process.execArgv,
        ...process.argv.slice(1).filter((a) => a !== "--daemon"),
      ];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ["ignore", out, err],
    cwd: process.cwd(),
    env: { ...process.env, WECHAT_ACP_DAEMON: "1" },
    windowsHide: true,
  });

  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf-8");
  console.log(`Daemon started (PID ${child.pid})`);
  console.log(`Logs: ${logFile}`);
  console.log(`PID file: ${pidFile}`);
  process.exit(0);
}

function renderQrInTerminal(url: string): void {
  qrcodeTerminal.generate(url, { small: true }, (qr: string) => {
    console.log(qr);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.version) {
    console.log(packageJson.version);
    process.exit(0);
  }

  if (args.help) {
    usage();
    process.exit(0);
  }

  if (args.instance !== undefined) {
    try {
      validateInstanceName(args.instance);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const config = defaultConfig({ instance: args.instance });

  // Load config file if specified
  let configFileSetInboxDir = false;
  let configFileSetStateFile = false;
  let configFileSetInjectDir = false;
  if (args.configFile) {
    const fileConfig = loadConfigFile(args.configFile);
    Object.assign(config.wechat, fileConfig.wechat ?? {});
    Object.assign(config.agent, fileConfig.agent ?? {});
    Object.assign(config.agents, fileConfig.agents ?? {});
    Object.assign(config.session, fileConfig.session ?? {});
    Object.assign(config.daemon, fileConfig.daemon ?? {});
    if (Object.prototype.hasOwnProperty.call(fileConfig, "commandAliases")) {
      // Assign the raw value (even if malformed) so the post-merge
      // validateCommandAliases() below can reject it with a clean error.
      config.commandAliases = fileConfig.commandAliases;
    }
    // Track whether the user explicitly set inboxDir so we don't
    // overwrite their choice with a re-derived default below. We check
    // before Object.assign because checking after can't distinguish
    // "user wrote inboxDir: null to disable" from "user didn't write it".
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "inboxDir")
    ) {
      configFileSetInboxDir = true;
    }
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "stateFile")
    ) {
      configFileSetStateFile = true;
    }
    if (
      fileConfig.storage &&
      Object.prototype.hasOwnProperty.call(fileConfig.storage, "injectDir")
    ) {
      configFileSetInjectDir = true;
    }
    Object.assign(config.storage, fileConfig.storage ?? {});
  }

  // CLI --instance always wins over config-file storage.dir so users can
  // run a config in multiple isolated instances without editing the file.
  if (args.instance) {
    config.storage.instance = args.instance;
    config.storage.dir = defaultStorageDir(args.instance);
    config.daemon.logFile = path.join(config.storage.dir, "wechat-acp.log");
    config.daemon.pidFile = path.join(config.storage.dir, "daemon.pid");
  }

  // Resolve the final inbox directory. Precedence (highest first):
  //   1. --no-inbox            (explicit disable)
  //   2. --inbox-dir <path>    (explicit CLI override)
  //   3. config.storage.inboxDir explicitly set in the config file
  //      (relative paths are resolved against cwd)
  //   4. Default: <storage.dir>/inbox, re-derived from whatever the
  //      final storage.dir is. This is what keeps a config file that
  //      only sets storage.dir consistent with the documented
  //      "default: <storage.dir>/inbox", and also covers the
  //      --instance case for free.
  if (args.disableInbox) {
    config.storage.inboxDir = null;
  } else if (args.inboxDir) {
    config.storage.inboxDir = path.resolve(args.inboxDir);
  } else if (configFileSetInboxDir) {
    if (config.storage.inboxDir && !path.isAbsolute(config.storage.inboxDir)) {
      config.storage.inboxDir = path.resolve(config.storage.inboxDir);
    }
  } else {
    config.storage.inboxDir = path.join(config.storage.dir, "inbox");
  }

  if (configFileSetStateFile) {
    if (config.storage.stateFile && !path.isAbsolute(config.storage.stateFile)) {
      config.storage.stateFile = path.resolve(config.storage.stateFile);
    }
  } else {
    config.storage.stateFile = path.join(config.storage.dir, "state.json");
  }

  if (configFileSetInjectDir) {
    if (config.storage.injectDir && !path.isAbsolute(config.storage.injectDir)) {
      config.storage.injectDir = path.resolve(config.storage.injectDir);
    }
  } else {
    config.storage.injectDir = path.join(config.storage.dir, "inject");
  }

  try {
    validateCommandAliases(config.commandAliases);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }

  // Handle subcommands
  if (args.command === "agents") {
    handleAgents(config);
    return;
  }
  if (args.command === "inject") {
    await handleInject(config, args);
    return;
  }
  if (args.command === "stop") {
    handleStop(config);
    return;
  }
  if (args.command === "status") {
    handleStatus(config);
    return;
  }
  if (args.command === "list") {
    handleList(config);
    return;
  }
  if (args.command === "restart") {
    await handleRestart(config, args);
    return;
  }

  const agentSelection = args.agent ?? config.agent.preset;

  // Require preset or raw command
  if (!agentSelection && !config.agent.command) {
    console.error("Error: --agent is required\n");
    usage();
    process.exit(1);
  }

  if (agentSelection) {
    const resolvedAgent = resolveAgentSelection(agentSelection, config.agents);
    config.agent.preset = resolvedAgent.id;
    config.agent.command = resolvedAgent.command;
    config.agent.args = resolvedAgent.args;
    if (resolvedAgent.env) {
      config.agent.env = { ...(config.agent.env ?? {}), ...resolvedAgent.env };
    }
  }

  if (args.cwd) config.agent.cwd = path.resolve(args.cwd);
  if (args.idleTimeout !== undefined) {
    if (!Number.isFinite(args.idleTimeout) || args.idleTimeout < 0) {
      console.error("Error: invalid --idle-timeout value");
      console.error('Use a non-negative integer minute value, where "0" means unlimited.');
      process.exit(1);
    }
    config.session.idleTimeoutMs = args.idleTimeout * 60_000;
  }
  if (args.maxSessions) config.session.maxConcurrentUsers = args.maxSessions;
  if (args.hideThoughts) config.agent.showThoughts = false;
  if (args.showDiffs) config.agent.showDiffs = true;
  config.daemon.enabled = args.daemon;

  // Handle daemon mode
  if (args.daemon && !process.env.WECHAT_ACP_DAEMON) {
    const pidFile = config.daemon.pidFile;
    if (fs.existsSync(pidFile)) {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (pid && !Number.isNaN(pid)) {
        try {
          process.kill(pid, 0);
          console.log(`Already running (PID ${pid}), skipping.`);
          console.log(`Use "npx @alintever/wechat-acp stop --instance ${args.instance ?? "default"}" to stop.`);
          process.exit(0);
        } catch {
          fs.unlinkSync(pidFile);
        }
      }
    }
    daemonize(config, {
      agent: agentSelection,
      argv: process.argv.slice(2).filter((a) => a !== "--daemon"),
    });
    return;
  }

  // Initialize telemetry. No-op when WECHAT_ACP_TELEMETRY=0/false/off.
  initTelemetry({
    version: packageJson.version,
    storageDir: config.storage.dir,
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  trackEvent("app.start", {
    agentPreset: config.agent.preset ?? "raw",
    daemon: config.daemon.enabled,
  });
  const startedAt = Date.now();

  // Create and start bridge
  const bridgeLog = (msg: string) => {
    const ts = new Date().toISOString().substring(11, 19);
    console.log(`[${ts}] ${msg}`);
  };
  let bridge = new WeChatAcpBridge(config, bridgeLog);

  // Handle graceful shutdown
  let shuttingDown = false;
  const shutdown = (reason: "signal" | "error" | "normal") => {
    if (shuttingDown) return;
    shuttingDown = true;
    trackEvent("app.stop", { reason, uptimeSec: Math.round((Date.now() - startedAt) / 1000) });
    bridge.stop().finally(() => {
      shutdownTelemetry().finally(() => process.exit(reason === "error" ? 1 : 0));
    });
  };
  process.on("SIGINT", () => void shutdown("signal"));
  process.on("SIGTERM", () => void shutdown("signal"));

  // In daemon mode, auto-restart the bridge on unexpected death
  if (config.daemon.enabled && process.env.WECHAT_ACP_DAEMON) {
    let restartCount = 0;
    const maxRestarts = 10;
    const restartCapMs = 60_000;

    while (!shuttingDown) {
      try {
        await bridge.start({
          forceLogin: args.forceLogin && restartCount === 0,
          renderQrUrl: renderQrInTerminal,
        });
        // Normal shutdown (aborted signal), don't restart
        break;
      } catch (err) {
        if (shuttingDown || (err as Error).message === "aborted") break;

        restartCount++;
        trackException(err, "daemon.crash");
        console.error(`[daemon] bridge crashed (restart ${restartCount}/${maxRestarts}): ${String(err)}`);

        // Kill the old bridge's agent processes before restarting
        console.error(`[daemon] stopping old bridge before restart...`);
        await bridge.stop();

        if (restartCount >= maxRestarts) {
          console.error("[daemon] max restarts reached, giving up");
          process.exit(1);
        }

        const delay = Math.min(1000 * Math.pow(2, restartCount), restartCapMs);
        console.error(`[daemon] restarting in ${delay / 1000}s...`);
        await new Promise((r) => {
          const t = setTimeout(r, delay);
          process.on("SIGTERM", () => { clearTimeout(t); });
          process.on("SIGINT", () => { clearTimeout(t); });
        });

        // Recreate bridge for fresh state
        bridge = new WeChatAcpBridge(config, bridgeLog);
      }
    }
  } else {
    await bridge.start({
      forceLogin: args.forceLogin,
      renderQrUrl: renderQrInTerminal,
    });
  }
}

main().catch((err) => {
  console.error(`Fatal: ${String(err)}`);
  process.exit(1);
});
