#!/usr/bin/env node
/**
 * Feishu File Upload & Download Demo
 *
 * Usage:
 *   # Upload a file to a chat
 *   node demo/feishu-file-demo.mjs upload <chat_id> <file_path>
 *
 *   # Upload an image to a chat
 *   node demo/feishu-file-demo.mjs upload-image <chat_id> <image_path>
 *
 *   # Download a resource from a message
 *   node demo/feishu-file-demo.mjs download <message_id> <file_key> [image|file]
 *
 *   # List recent chats (to find chat_id)
 *   node demo/feishu-file-demo.mjs list-chats
 *
 * Reads config from ~/.claude-to-im/config.env
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// ── Load config.env ──────────────────────────────────────────
const CONFIG_PATH = path.join(os.homedir(), '.claude-to-im', 'config.env');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Config not found: ${CONFIG_PATH}`);
  process.exit(1);
}

for (const line of fs.readFileSync(CONFIG_PATH, 'utf-8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 0) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  if (!process.env[key]) process.env[key] = value;
}

// ── Import Feishu SDK ────────────────────────────────────────
const require = createRequire(import.meta.url);
const lark = require(
  path.resolve(
    import.meta.url.replace('file://', ''),
    '../../node_modules/claude-to-im/node_modules/@larksuiteoapi/node-sdk',
  ),
);

const appId = process.env.CTI_FEISHU_APP_ID;
const appSecret = process.env.CTI_FEISHU_APP_SECRET;
const domainStr = process.env.CTI_FEISHU_DOMAIN || '';

if (!appId || !appSecret) {
  console.error('Missing CTI_FEISHU_APP_ID or CTI_FEISHU_APP_SECRET in config.env');
  process.exit(1);
}

const domain = domainStr.includes('lark') ? lark.Domain.Lark : lark.Domain.Feishu;
const client = new lark.Client({ appId, appSecret, domain });

console.log(`App ID:  ${appId}`);
console.log(`Domain:  ${domainStr || 'feishu (default)'}\n`);

// ── Commands ─────────────────────────────────────────────────

const FEISHU_FILE_TYPES = new Set(['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream']);

function toFeishuFileType(ext) {
  if (FEISHU_FILE_TYPES.has(ext)) return ext;
  const mapping = { docx: 'doc', xlsx: 'xls', pptx: 'ppt', m4a: 'opus', ogg: 'opus' };
  return mapping[ext] || 'stream';
}

async function uploadFile(receiveId, filePath, idType = 'chat_id') {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).replace(/^\./, '').toLowerCase() || 'bin';
  const fileType = toFeishuFileType(ext);
  const fileData = fs.readFileSync(filePath);

  console.log(`Uploading file: ${fileName} (${fileData.length} bytes, type: ${fileType})...`);

  // Step 1: Upload file to get file_key
  const uploadRes = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: fileName,
      file: fileData,
    },
  });

  const fileKey = uploadRes?.data?.file_key || uploadRes?.file_key;
  if (!fileKey) {
    console.error('Upload failed:', uploadRes?.msg || JSON.stringify(uploadRes));
    process.exit(1);
  }

  console.log(`Upload OK — file_key: ${fileKey}`);

  // Step 2: Send file message
  const sendRes = await client.im.message.create({
    params: { receive_id_type: idType },
    data: {
      receive_id: receiveId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
  });

  if (!sendRes?.data?.message_id) {
    console.error('Send failed:', sendRes?.msg || JSON.stringify(sendRes));
    process.exit(1);
  }

  console.log(`Sent — message_id: ${sendRes.data.message_id}`);
}

async function uploadImage(receiveId, imagePath, idType = 'chat_id') {
  if (!fs.existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  const imageData = fs.readFileSync(imagePath);
  console.log(`Uploading image: ${path.basename(imagePath)} (${imageData.length} bytes)...`);

  // Step 1: Upload image to get image_key
  const uploadRes = await client.im.image.create({
    data: {
      image_type: 'message',
      image: imageData,
    },
  });

  const imageKey = uploadRes?.data?.image_key || uploadRes?.image_key;
  if (!imageKey) {
    console.error('Image upload failed:', uploadRes?.msg || JSON.stringify(uploadRes));
    process.exit(1);
  }

  console.log(`Upload OK — image_key: ${imageKey}`);

  // Step 2: Send image message
  const sendRes = await client.im.message.create({
    params: { receive_id_type: idType },
    data: {
      receive_id: receiveId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
    },
  });

  if (!sendRes?.data?.message_id) {
    console.error('Send failed:', sendRes?.msg || JSON.stringify(sendRes));
    process.exit(1);
  }

  console.log(`Sent — message_id: ${sendRes.data.message_id}`);
}

async function downloadResource(messageId, fileKey, resourceType = 'file') {
  console.log(`Downloading: message_id=${messageId}, file_key=${fileKey}, type=${resourceType}...`);

  let res;
  try {
    res = await client.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: fileKey,
      },
      params: {
        type: resourceType,
      },
    });
  } catch (err) {
    // SDK throws on non-2xx; extract the real error body
    const errData = err?.[1] || err?.response?.data;
    if (errData?.code) {
      console.error(`Download API error (${errData.code}): ${errData.msg}`);
    } else {
      console.error('Download failed:', err?.message || err);
    }
    process.exit(1);
  }

  if (!res) {
    console.error('Download returned null');
    process.exit(1);
  }

  // Try stream approach
  let buffer;
  try {
    const readable = res.getReadableStream();
    const chunks = [];
    for await (const chunk of readable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    buffer = Buffer.concat(chunks);
  } catch {
    // Fallback: writeFile + read
    const tmpPath = path.join(os.tmpdir(), `feishu-demo-${Date.now()}`);
    try {
      await res.writeFile(tmpPath);
      buffer = fs.readFileSync(tmpPath);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  if (!buffer || buffer.length === 0) {
    console.error('Downloaded resource is empty');
    process.exit(1);
  }

  const ext = resourceType === 'image' ? 'png' : 'bin';
  const outFile = path.join(process.cwd(), `${fileKey}.${ext}`);
  fs.writeFileSync(outFile, buffer);
  console.log(`Downloaded ${buffer.length} bytes → ${outFile}`);
}

async function getMessageContent(messageId) {
  console.log(`Fetching message: ${messageId}...`);

  const res = await client.im.message.get({
    path: { message_id: messageId },
  });

  const msg = res?.data?.items?.[0] || res?.data;
  if (!msg) {
    console.error('Message not found:', JSON.stringify(res));
    process.exit(1);
  }

  console.log('Message info:');
  console.log(`  msg_type: ${msg.msg_type}`);
  console.log(`  content:  ${msg.body?.content || msg.content}`);
  console.log(`  sender:   ${msg.sender?.id || JSON.stringify(msg.sender)}`);
  return msg;
}

async function listChats() {
  console.log('Fetching bot chat list...\n');

  const res = await client.im.chat.list({
    params: { page_size: 20 },
  });

  if (!res?.data?.items?.length) {
    console.log('No group chats found. The bot may only have direct message conversations.');
    console.log('Tip: use "send" command with open_id to message a user directly.\n');
  } else {
    console.log('Chat ID                              | Name');
    console.log('─'.repeat(70));
    for (const chat of res.data.items) {
      console.log(`${chat.chat_id}  | ${chat.name || '(unnamed)'}`);
    }
    console.log(`\nTotal: ${res.data.items.length} chat(s)`);
  }

  // Also show bot info
  const botInfo = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' });
  if (botInfo?.bot) {
    console.log(`\nBot: ${botInfo.bot.app_name} (open_id: ${botInfo.bot.open_id})`);
  }
}

async function sendText(receiveId, text, idType = 'chat_id') {
  console.log(`Sending text to ${idType}=${receiveId}...`);

  const res = await client.im.message.create({
    params: { receive_id_type: idType },
    data: {
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  });

  if (!res?.data?.message_id) {
    console.error('Send failed:', res?.msg || JSON.stringify(res));
    process.exit(1);
  }

  console.log(`Sent — message_id: ${res.data.message_id}`);
}

// ── CLI Router ───────────────────────────────────────────────

const [,, command, ...args] = process.argv;

const HELP = `
Feishu File Upload & Download Demo

Commands:
  upload       <id> <file_path>  [--user]           Upload file (--user sends via open_id)
  upload-image <id> <image_path> [--user]           Upload image (--user sends via open_id)
  download     <message_id> <file_key> [image|file]  Download a resource from a message
  send         <id> <text> [--user]                  Send a text message (for quick test)
  list-chats                                         List bot's group chats & bot info

Examples:
  node demo/feishu-file-demo.mjs list-chats
  node demo/feishu-file-demo.mjs send oc_xxx ./hello
  node demo/feishu-file-demo.mjs send ou_xxx "hello from bot" --user
  node demo/feishu-file-demo.mjs upload oc_xxx123 ./report.pdf
  node demo/feishu-file-demo.mjs upload-image ou_xxx ./pic.png --user
  node demo/feishu-file-demo.mjs download om_xxx123 file_xxx123 file

Note:
  <id> is a chat_id (oc_...) by default.
  Add --user flag to treat <id> as an open_id (ou_...) for direct messages.
`.trim();

function parseIdType(argList) {
  const hasUser = argList.includes('--user');
  const filtered = argList.filter(a => a !== '--user');
  return { idType: hasUser ? 'open_id' : 'chat_id', args: filtered };
}

try {
  switch (command) {
    case 'upload': {
      const { idType, args: a } = parseIdType(args);
      if (a.length < 2) { console.error('Usage: upload <id> <file_path> [--user]'); process.exit(1); }
      await uploadFile(a[0], a[1], idType);
      break;
    }

    case 'upload-image': {
      const { idType, args: a } = parseIdType(args);
      if (a.length < 2) { console.error('Usage: upload-image <id> <image_path> [--user]'); process.exit(1); }
      await uploadImage(a[0], a[1], idType);
      break;
    }

    case 'download':
      if (args.length < 2) { console.error('Usage: download <message_id> <file_key> [image|file]'); process.exit(1); }
      await downloadResource(args[0], args[1], args[2] || 'file');
      break;

    case 'send': {
      const { idType, args: a } = parseIdType(args);
      if (a.length < 2) { console.error('Usage: send <id> <text> [--user]'); process.exit(1); }
      await sendText(a[0], a.slice(1).join(' '), idType);
      break;
    }

    case 'list-chats':
      await listChats();
      break;

    default:
      console.log(HELP);
      break;
  }
} catch (err) {
  console.error('\nAPI Error:', err?.response?.data || err?.message || err);
  process.exit(1);
}
