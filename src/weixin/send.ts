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

  // Generate a stable idempotency key for this logical send. Callers that
  // retry should pass the same clientId so the iLink gateway de-duplicates
  // repeated deliveries of the same message segment.
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
  const aesKey = crypto.randomBytes(16);
  const filekey = `${Date.now()}-${fileName}`;
  const md5 = crypto.createHash("md5").update(buffer).digest("hex");

  const uploadResp = await getUploadUrl({
    baseUrl: opts.baseUrl,
    token: opts.token,
    body: {
      filekey,
      media_type: UploadMediaType.FILE,
      to_user_id: to,
      rawsize: buffer.length,
      filesize: buffer.length,
      rawfilemd5: md5,
    },
  });

  if (!uploadResp.upload_param) {
    throw new Error("getUploadUrl returned no upload_param");
  }

  const downloadParam = await uploadToCdn({
    buffer,
    uploadParam: uploadResp.upload_param,
    aesKey,
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
            media: {
              encrypt_query_param: downloadParam,
              aes_key: aesKey.toString("base64"),
            },
          },
        }],
      },
    },
  });
  return id;
}

/**
 * Split text into segments of max length, respecting line breaks where possible.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      segments.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = maxLen;

    segments.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).replace(/^\n/, "");
  }

  return segments;
}
