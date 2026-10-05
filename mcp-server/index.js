#!/usr/bin/env node
// Typist MCP server: exposes list_fields / type_text / cancel to Claude and
// forwards them to the Typist Chrome extension.
//
// Claude decides WHAT to type and where. HOW it's typed (speed variation,
// mistakes, corrections) is extension settings, so type_text deliberately
// accepts nothing beyond text, target, wpm, mode and newline.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.js';

const DEFAULT_PORT = 17373;
const log = (...args) => console.error('[typist]', ...args); // stdout belongs to MCP

function loadConfig() {
  const dir = process.env.TYPIST_CONFIG_DIR ?? join(homedir(), '.typist');
  const file = join(dir, 'config.json');
  let config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (!config?.token) {
    config = { port: DEFAULT_PORT, token: randomBytes(16).toString('hex'), ...config };
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  }
  return {
    port: Number(process.env.TYPIST_PORT ?? config.port ?? DEFAULT_PORT),
    token: process.env.TYPIST_TOKEN ?? config.token,
    extensionId: process.env.TYPIST_EXTENSION_ID ?? config.extensionId,
    file,
  };
}

const config = loadConfig();
if (process.argv.includes('--print-token')) {
  console.log(`port:  ${config.port}\ntoken: ${config.token}\n(from ${config.file})`);
  process.exit(0);
}

const bridge = new Bridge({ ...config, log });
await bridge.start();

const server = new McpServer({ name: 'typist', version: '0.1.0' });
const json = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError });
const failure = (e) => json({ ok: false, verified: false, error: e.message }, true);

server.registerTool('list_fields', {
  title: 'List text fields',
  description: 'List the editable text fields (inputs, textareas, contenteditable and rich-text editors) on the active tab of the user\'s Chrome window. '
    + 'Returns each field\'s id, kind, label, a preview of its current text and whether it is focused. Pass an id as `target` to type_text. Password values are masked.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true },
}, async () => {
  try { return json(await bridge.request('list_fields')); } catch (e) { return failure(e); }
});

server.registerTool('type_text', {
  title: 'Type text',
  description: 'Type text into a field in the user\'s Chrome tab, one key at a time, as a person would. '
    + 'You choose what to type and where. The Typist extension decides how: typing rhythm, temporary typos and their corrections all come from the user\'s extension settings. '
    + 'When typing ends, the extension reads the field back. `ok: true` means the field\'s text was verified to be exactly right. '
    + 'If `ok` is false, the field may contain partial text; report the error to the user rather than retrying blindly. '
    + 'Typing takes real time (about 12000/wpm ms per character), so long text takes a while.',
  inputSchema: z.object({
    text: z.string().describe('Exactly the text that should be entered.'),
    target: z.string().optional().describe('A field id from list_fields (e.g. "f3", or "f2@57" inside an iframe) or a CSS selector. Omit to type into the field that currently has focus.'),
    wpm: z.number().min(10).max(200).optional().describe('Typing speed for this request only. Omit to use the user\'s configured speed; set it only when the user asks for a speed.'),
    mode: z.enum(['insert', 'replace']).optional().describe('"insert": type at the caret, keeping existing text (contenteditable fields type at the end). "replace": clear the field first. Defaults to the user\'s setting.'),
    newline: z.enum(['enter', 'shift_enter']).optional().describe('How line breaks are typed. Use "shift_enter" in chat boxes where Enter sends the message. Defaults to the user\'s setting.'),
  }).strict(),
  annotations: { destructiveHint: true, openWorldHint: true },
}, async (params, extra) => {
  const progressToken = extra._meta?.progressToken;
  const onProgress = progressToken === undefined ? undefined : ({ done, total }) => {
    extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: done, total } }).catch(() => {});
  };
  try {
    const result = await bridge.request('type_text', params, { onProgress, signal: extra.signal });
    return json(result, !result.ok);
  } catch (e) {
    return failure(e);
  }
});

server.registerTool('cancel', {
  title: 'Cancel typing',
  description: 'Stop the type_text job that is running. Text typed so far stays in the field.',
  inputSchema: z.object({}).strict(),
}, async () => {
  try { return json(await bridge.request('cancel')); } catch (e) { return failure(e); }
});

await server.connect(new StdioServerTransport());
log('MCP server ready');
