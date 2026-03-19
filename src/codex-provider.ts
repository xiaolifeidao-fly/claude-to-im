/**
 * Codex Provider — LLMProvider implementation backed by @openai/codex-sdk.
 *
 * Maps Codex SDK thread events to the SSE stream format consumed by
 * the bridge conversation engine, making Codex a drop-in alternative
 * to the Claude Code SDK backend.
 *
 * Requires `@openai/codex-sdk` to be installed (optionalDependency).
 * The provider lazily imports the SDK at first use and throws a clear
 * error if it is not available.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

/** MIME → file extension for temp image files. */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const EXT_TO_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.jsx': 'text/javascript',
  '.tsx': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.yml': 'application/yaml',
  '.yaml': 'application/yaml',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

const MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024;

// All SDK types kept as `any` because @openai/codex-sdk is optional.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CodexInstance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ThreadInstance = any;

interface CodexStreamState {
  agentTextById: Map<string, string>;
  startedToolIds: Set<string>;
  outputFilesByPath: Map<string, import('claude-to-im/src/lib/bridge/host.js').FileAttachment>;
  workingDirectory?: string;
}

function guessMimeType(filePath: string): string {
  return EXT_TO_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const TEXTUAL_MIME_EXACT = new Set([
  'application/json', 'application/xml', 'application/yaml',
  'application/javascript', 'application/typescript',
  'application/x-sh', 'application/x-python',
]);

function isTextualMime(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true;
  return TEXTUAL_MIME_EXACT.has(mimeType);
}

function collectOutputFile(
  workingDirectory: string | undefined,
  changePath: string,
): import('claude-to-im/src/lib/bridge/host.js').FileAttachment | null {
  const absolutePath = path.isAbsolute(changePath)
    ? changePath
    : (workingDirectory ? path.resolve(workingDirectory, changePath) : '');
  if (!absolutePath || !fs.existsSync(absolutePath)) return null;

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size > MAX_OUTBOUND_FILE_BYTES) return null;

  return {
    id: absolutePath,
    name: path.basename(absolutePath),
    type: guessMimeType(absolutePath),
    size: stat.size,
    data: fs.readFileSync(absolutePath).toString('base64'),
    filePath: absolutePath,
  };
}

function shouldDebugCodexEvents(): boolean {
  return process.env.CTI_CODEX_DEBUG_EVENTS === 'true';
}

function summarizeCodexItem(item: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: item.id as string | undefined,
    type: item.type as string | undefined,
  };

  switch (item.type) {
    case 'agent_message':
      return {
        ...base,
        textLength: typeof item.text === 'string' ? item.text.length : 0,
      };
    case 'command_execution':
      return {
        ...base,
        status: item.status as string | undefined,
        command: item.command as string | undefined,
        outputLength: typeof item.aggregated_output === 'string' ? item.aggregated_output.length : 0,
        exitCode: item.exit_code as number | undefined,
      };
    case 'file_change':
      return {
        ...base,
        status: item.status as string | undefined,
        changes: Array.isArray(item.changes) ? item.changes : [],
      };
    case 'mcp_tool_call':
      return {
        ...base,
        status: item.status as string | undefined,
        server: item.server as string | undefined,
        tool: item.tool as string | undefined,
        hasError: !!item.error,
      };
    case 'reasoning':
      return {
        ...base,
        textLength: typeof item.text === 'string' ? item.text.length : 0,
      };
    default:
      return base;
  }
}

/**
 * Map bridge permission modes to Codex approval policies.
 * - 'acceptEdits' (code mode) → 'on-failure' (auto-approve most things)
 * - 'plan' → 'on-request' (ask before executing)
 * - 'default' (ask mode) → 'on-request'
 */
function toApprovalPolicy(permissionMode?: string): string {
  switch (permissionMode) {
    case 'acceptEdits': return 'on-failure';
    case 'plan': return 'on-request';
    case 'default': return 'on-request';
    default: return 'on-request';
  }
}

/** Whether to forward bridge model to Codex CLI. Default: false (use Codex current/default model). */
function shouldPassModelToCodex(): boolean {
  return process.env.CTI_CODEX_PASS_MODEL === 'true';
}

function shouldRetryFreshThread(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('resuming session with different model') ||
    lower.includes('no such session') ||
    (lower.includes('resume') && lower.includes('session'))
  );
}

export class CodexProvider implements LLMProvider {
  private sdk: CodexModule | null = null;
  private codex: CodexInstance | null = null;

  /** Maps session IDs to Codex thread IDs for resume. */
  private threadIds = new Map<string, string>();

  constructor(private pendingPerms: PendingPermissions) {}

  /**
   * Lazily load the Codex SDK. Throws a clear error if not installed.
   */
  private async ensureSDK(): Promise<{ sdk: CodexModule; codex: CodexInstance }> {
    if (this.sdk && this.codex) {
      return { sdk: this.sdk, codex: this.codex };
    }

    try {
      this.sdk = await (Function('return import("@openai/codex-sdk")')() as Promise<CodexModule>);
    } catch {
      throw new Error(
        '[CodexProvider] @openai/codex-sdk is not installed. ' +
        'Install it with: npm install @openai/codex-sdk'
      );
    }

    // Resolve API key: CTI_CODEX_API_KEY > CODEX_API_KEY > OPENAI_API_KEY > (login auth)
    const apiKey = process.env.CTI_CODEX_API_KEY
      || process.env.CODEX_API_KEY
      || process.env.OPENAI_API_KEY
      || undefined;
    const baseUrl = process.env.CTI_CODEX_BASE_URL || undefined;

    const CodexClass = this.sdk.Codex;
    this.codex = new CodexClass({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });

    return { sdk: this.sdk, codex: this.codex };
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const self = this;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const tempFiles: string[] = [];
          const streamState: CodexStreamState = {
            agentTextById: new Map(),
            startedToolIds: new Set(),
            outputFilesByPath: new Map(),
            workingDirectory: params.workingDirectory,
          };
          try {
            const { codex } = await self.ensureSDK();

            // Resolve or create thread
            let savedThreadId = params.sdkSessionId
              ? self.threadIds.get(params.sessionId) || params.sdkSessionId
              : undefined;

            const approvalPolicy = toApprovalPolicy(params.permissionMode);
            const passModel = shouldPassModelToCodex();

            const threadOptions: Record<string, unknown> = {
              ...(passModel && params.model ? { model: params.model } : {}),
              ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
              skipGitRepoCheck: true,
              approvalPolicy,
            };

            // Build input: Codex SDK UserInput supports { type: "text" } and
            // { type: "local_image", path: string }. We write base64 data to
            // temp files so the SDK can read them as local images.
            // Text files (txt, md, json, etc.) are inlined into the prompt.
            const imageFiles = params.files?.filter(
              f => f.type.startsWith('image/')
            ) ?? [];
            const textFiles = params.files?.filter(
              f => !f.type.startsWith('image/') && isTextualMime(f.type)
            ) ?? [];
            const otherFiles = params.files?.filter(
              f => !f.type.startsWith('image/') && !isTextualMime(f.type)
            ) ?? [];

            // Build text prefix with inlined text file contents
            let promptText = params.prompt;
            if (textFiles.length > 0 || otherFiles.length > 0) {
              const fileParts: string[] = [];
              for (const file of textFiles) {
                try {
                  const decoded = Buffer.from(file.data, 'base64').toString('utf-8');
                  fileParts.push(`--- File: ${file.name} (${file.size} bytes) ---\n${decoded}\n--- End of ${file.name} ---`);
                } catch {
                  fileParts.push(`[File: ${file.name} — failed to decode]`);
                }
              }
              for (const file of otherFiles) {
                const pathInfo = file.filePath
                  ? ` — saved to disk: ${file.filePath}`
                  : ' — binary file received';
                fileParts.push(`[File: ${file.name} (${file.type}, ${file.size} bytes)${pathInfo}]`);
              }
              promptText = fileParts.join('\n\n') + '\n\n' + promptText;
            }

            let input: string | Array<Record<string, string>>;
            if (imageFiles.length > 0) {
              const parts: Array<Record<string, string>> = [
                { type: 'text', text: promptText },
              ];
              for (const file of imageFiles) {
                const ext = MIME_EXT[file.type] || '.png';
                const tmpPath = path.join(os.tmpdir(), `cti-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                fs.writeFileSync(tmpPath, Buffer.from(file.data, 'base64'));
                tempFiles.push(tmpPath);
                parts.push({ type: 'local_image', path: tmpPath });
              }
              input = parts;
            } else {
              input = promptText;
            }

            let retryFresh = false;

            while (true) {
              let thread: ThreadInstance;
              if (savedThreadId) {
                try {
                  thread = codex.resumeThread(savedThreadId, threadOptions);
                } catch {
                  thread = codex.startThread(threadOptions);
                }
              } else {
                thread = codex.startThread(threadOptions);
              }

              let sawAnyEvent = false;
              try {
                const { events } = await thread.runStreamed(input, {
                  signal: params.abortController?.signal,
                });

                for await (const event of events) {
                  sawAnyEvent = true;
                  if (params.abortController?.signal.aborted) {
                    break;
                  }

                  switch (event.type) {
                    case 'thread.started': {
                      const threadId = event.thread_id as string;
                      self.threadIds.set(params.sessionId, threadId);
                      if (shouldDebugCodexEvents()) {
                        console.log('[codex-provider][event]', JSON.stringify({
                          sessionId: params.sessionId,
                          event: 'thread.started',
                          threadId,
                        }));
                      }

                      controller.enqueue(sseEvent('status', {
                        session_id: threadId,
                      }));
                      break;
                    }

                    case 'item.started':
                    case 'item.updated':
                    case 'item.completed': {
                      const item = event.item as Record<string, unknown>;
                      if (shouldDebugCodexEvents()) {
                        console.log('[codex-provider][event]', JSON.stringify({
                          sessionId: params.sessionId,
                          event: event.type,
                          item: summarizeCodexItem(item),
                        }));
                      }
                      self.handleItemEvent(controller, item, event.type, streamState);
                      break;
                    }

                    case 'turn.completed': {
                      const usage = event.usage as Record<string, unknown> | undefined;
                      const threadId = self.threadIds.get(params.sessionId);
                      if (shouldDebugCodexEvents()) {
                        console.log('[codex-provider][event]', JSON.stringify({
                          sessionId: params.sessionId,
                          event: 'turn.completed',
                          threadId,
                          usage,
                        }));
                      }

                      const outputFilesArray = Array.from(streamState.outputFilesByPath.values());
                      if (outputFilesArray.length > 0) {
                        console.log(`[codex-provider] turn.completed: emitting ${outputFilesArray.length} output file(s): ${outputFilesArray.map(f => f.name).join(', ')}`);
                      }
                      controller.enqueue(sseEvent('result', {
                        usage: usage ? {
                          input_tokens: usage.input_tokens ?? 0,
                          output_tokens: usage.output_tokens ?? 0,
                          cache_read_input_tokens: usage.cached_input_tokens ?? 0,
                        } : undefined,
                        output_files: outputFilesArray,
                        ...(threadId ? { session_id: threadId } : {}),
                      }));
                      break;
                    }

                    case 'turn.failed': {
                      const error = (event as { message?: string; error?: { message?: string } }).message
                        || (event as { error?: { message?: string } }).error?.message;
                      if (shouldDebugCodexEvents()) {
                        console.warn('[codex-provider][event]', JSON.stringify({
                          sessionId: params.sessionId,
                          event: 'turn.failed',
                          error,
                        }));
                      }
                      controller.enqueue(sseEvent('error', error || 'Turn failed'));
                      break;
                    }

                    case 'error': {
                      const error = (event as { message?: string }).message;
                      if (shouldDebugCodexEvents()) {
                        console.warn('[codex-provider][event]', JSON.stringify({
                          sessionId: params.sessionId,
                          event: 'error',
                          error,
                        }));
                      }
                      controller.enqueue(sseEvent('error', error || 'Thread error'));
                      break;
                    }

                    // item.started, item.updated, turn.started — no action needed
                  }
                }
                break;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                if (savedThreadId && !retryFresh && !sawAnyEvent && shouldRetryFreshThread(message)) {
                  console.warn('[codex-provider] Resume failed, retrying with a fresh thread:', message);
                  savedThreadId = undefined;
                  retryFresh = true;
                  continue;
                }
                throw err;
              }
            }

            controller.close();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[codex-provider] Error:', err instanceof Error ? err.stack || err.message : err);
            try {
              controller.enqueue(sseEvent('error', message));
              controller.close();
            } catch {
              // Controller already closed
            }
          } finally {
            // Clean up temp image files
            for (const tmp of tempFiles) {
              try { fs.unlinkSync(tmp); } catch { /* ignore */ }
            }
          }
        })();
      },
    });
  }

  /**
   * Map Codex item lifecycle events to SSE events.
   */
  private handleItemEvent(
    controller: ReadableStreamDefaultController<string>,
    item: Record<string, unknown>,
    eventType: 'item.started' | 'item.updated' | 'item.completed',
    state: CodexStreamState,
  ): void {
    const itemType = item.type as string;
    const itemId = (item.id as string) || `${itemType}-${Date.now()}`;

    switch (itemType) {
      case 'agent_message': {
        const text = (item.text as string) || '';
        const prev = state.agentTextById.get(itemId) || '';

        if (text && (!prev || (text.length > prev.length && text.startsWith(prev)))) {
          const delta = prev ? text.slice(prev.length) : text;
          if (delta) {
            controller.enqueue(sseEvent('text', delta));
          }
        }

        state.agentTextById.set(itemId, text);
        break;
      }

      case 'command_execution': {
        const toolId = itemId;
        const command = item.command as string || '';
        const output = item.aggregated_output as string || '';
        const exitCode = item.exit_code as number | undefined;
        const isError = exitCode != null && exitCode !== 0;

        if (!state.startedToolIds.has(toolId)) {
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: 'Bash',
            input: { command },
          }));
          state.startedToolIds.add(toolId);
        }

        if (eventType === 'item.completed') {
          const resultContent = output || (isError ? `Exit code: ${exitCode}` : 'Done');
          controller.enqueue(sseEvent('tool_result', {
            tool_use_id: toolId,
            content: resultContent,
            is_error: isError,
          }));
        }
        break;
      }

      case 'file_change': {
        const toolId = itemId;
        const changes = item.changes as Array<{ path: string; kind: string }> || [];
        const summary = changes.map(c => `${c.kind}: ${c.path}`).join('\n');

        if (eventType === 'item.completed' && changes.length > 0) {
          console.log(`[codex-provider] file_change completed: ${summary}`);
        }

        for (const change of changes) {
          if (change.kind === 'delete') continue;
          const attachment = collectOutputFile(state.workingDirectory, change.path);
          if (attachment) {
            console.log(`[codex-provider] Collected output file: ${attachment.name} (${attachment.size} bytes, ${attachment.type})`);
            state.outputFilesByPath.set(attachment.filePath || attachment.id, attachment);
          } else if (eventType === 'item.completed') {
            console.warn(`[codex-provider] Could not collect output file: ${change.path} (workDir=${state.workingDirectory})`);
          }
        }

        if (!state.startedToolIds.has(toolId)) {
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: 'Edit',
            input: { files: changes },
          }));
          state.startedToolIds.add(toolId);
        }

        if (eventType === 'item.completed') {
          controller.enqueue(sseEvent('tool_result', {
            tool_use_id: toolId,
            content: summary || 'File changes applied',
            is_error: false,
          }));
        }
        break;
      }

      case 'mcp_tool_call': {
        const toolId = itemId;
        const server = item.server as string || '';
        const tool = item.tool as string || '';
        const args = item.arguments as unknown;
        const result = item.result as { content?: unknown; structured_content?: unknown } | undefined;
        const error = item.error as { message?: string } | undefined;

        const resultContent = result?.content ?? result?.structured_content;
        const resultText = typeof resultContent === 'string' ? resultContent : (resultContent ? JSON.stringify(resultContent) : undefined);

        if (!state.startedToolIds.has(toolId)) {
          controller.enqueue(sseEvent('tool_use', {
            id: toolId,
            name: `mcp__${server}__${tool}`,
            input: args,
          }));
          state.startedToolIds.add(toolId);
        }

        if (eventType === 'item.completed') {
          controller.enqueue(sseEvent('tool_result', {
            tool_use_id: toolId,
            content: error?.message || resultText || 'Done',
            is_error: !!error,
          }));
        }
        break;
      }

      case 'reasoning': {
        // Reasoning is internal; emit as status
        const text = (item.text as string) || '';
        if (text) {
          controller.enqueue(sseEvent('status', { reasoning: text }));
        }
        break;
      }
    }
  }
}
