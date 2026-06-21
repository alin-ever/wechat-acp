/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import type * as acp from "@agentclientprotocol/sdk";
import crypto from "node:crypto";
import { login, loadToken, type TokenData } from "./weixin/auth.js";
import { startMonitor } from "./weixin/monitor.js";
import { sendTextMessage, splitText } from "./weixin/send.js";
import { sendTyping, getConfig } from "./weixin/api.js";
import { TypingStatus, MessageType } from "./weixin/types.js";
import type { WeixinMessage } from "./weixin/types.js";
import { SessionManager } from "./acp/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import type { WeChatAcpConfig } from "./config.js";
import { BRIDGE_COMMANDS, resolveCommandAliases, resolveCommandNames } from "./config.js";
import { InjectionMonitor } from "./inject/monitor.js";
import type { InjectedMessage } from "./inject/types.js";
import { resolveUserTarget, updateLastActiveUser } from "./storage/state.js";
import { trackEvent, trackException, hashUserId } from "./telemetry/index.js";

const ACP_CONFIG_COMMAND = BRIDGE_COMMANDS.acpConfig;
const ACP_CANCEL_COMMAND = BRIDGE_COMMANDS.acpCancel;
const BUFFER_START_COMMAND = BRIDGE_COMMANDS.promptStart;
const BUFFER_DONE_COMMAND = BRIDGE_COMMANDS.promptDone;
const TEXT_CHUNK_LIMIT = 2000;