/**
 * Send messages via WeChat iLink API.
 */

import crypto from "node:crypto";
import { sendMessage, getUploadUrl } from "./api.js";
import { uploadToCdn } from "./media.js";
import { MessageType, MessageState, MessageItemType, UploadMediaType } from "./types.js";

export interface WeixinSendOpts {
  baseUrl: string;
  token?: string;
  contextToken?: string;
}

function aesEcbPaddedSize(rawsize: number): number {
  return Math.ceil(rawsize / 16) * 16;
}

export async function sendTextMessage(
  to: string,
  text: string,
  opts: WeixinSendOpts,
  clientId?: string,
  sendFn: typeof sendMessage = sendMessage,
): Promise<string> {
  if (!opts.contextToken) {
    throw new Error("contextToken is required to send a message");
  }

  const id = clientId ?? `wechat-acp-${crypto.randomUUID()}`;
  await sendFn({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: id,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: opts.contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
    },
  });
  return id;
}

export async function sendFileMessage(
  to: string,
  buffer: Buffer,
  fileName: string,
  opts: WeixinSendOpts & { cdnBaseUrl: string },
  clientId?: string,
): Promise<string> {
  const rawsize = buffer.length;
  const rawfilemd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString("hex");

  const uploadUrlResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey,
      media_type: UploadMediaType.FILE,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize,
      no_need_thumb: true,
      aeskey: aeskeyHex,
    },
  });

  const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
  const uploadParam = uploadUrlResp.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error("getUploadUrl returned no upload URL");
  }

  const { downloadParam } = await uploadToCdn({
    buffer,
    uploadFullUrl: uploadFullUrl || undefined,
    uploadParam: uploadParam ?? undefined,
    aesKey: aeskey,
    filekey,
    cdnBaseUrl: opts.cdnBaseUrl,
  });

  const id = clientId ?? `wechat-acp-${crypto.randomUUID()}`;
  await sendMessage({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: id,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: opts.contextToken,
        item_list: [{
          type: MessageItemType.FILE,
          file_item: {
            file_name: fileName,
            len: String(rawsize),
            media: {
              encrypt_query_param: downloadParam,
              aes_key: Buffer.from(aeskeyHex).toString("base64"),
              encrypt_type: 1,
            },
          },
        }],
      },
    },
  });
  return id;
}

/**
 * Split text into segments whose UTF-8 byte length ≤ maxLen.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (Buffer.byteLength(text, "utf-8") <= maxLen) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, "utf-8") <= maxLen) {
      segments.push(remaining);
      break;
    }

    let breakAt = remaining.lastIndexOf("\n");
    if (breakAt <= 0 || Buffer.byteLength(remaining.substring(0, breakAt), "utf-8") > maxLen) {
      let lo = 0;
      let hi = remaining.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (Buffer.byteLength(remaining.substring(0, mid), "utf-8") <= maxLen) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      breakAt = lo || 1;
    }

    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }

  return segments;
}
