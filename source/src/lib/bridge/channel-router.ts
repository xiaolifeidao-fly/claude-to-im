/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';

interface FeishuConnectionDefaults {
  workDir?: string;
  model?: string;
  mode?: string;
}

interface ChannelBindingDefaults {
  workDir: string;
  model: string;
  mode: ChannelBinding['mode'];
}

function getFeishuConnectionDefaults(connectionId: string | undefined): FeishuConnectionDefaults {
  if (!connectionId) return {};
  const raw = getBridgeContext().store.getSetting('bridge_feishu_bots');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    const match = parsed.find((entry) => entry?.id === connectionId);
    if (!match) return {};
    return {
      workDir: typeof match.workDir === 'string' ? match.workDir : undefined,
      model: typeof match.model === 'string' ? match.model : undefined,
      mode: typeof match.mode === 'string' ? match.mode : undefined,
    };
  } catch {
    return {};
  }
}

export function getBindingDefaults(address: ChannelAddress): ChannelBindingDefaults {
  const { store } = getBridgeContext();
  const connectionDefaults = address.channelType === 'feishu'
    ? getFeishuConnectionDefaults(address.connectionId)
    : {};

  return {
    workDir: connectionDefaults.workDir
      || store.getSetting('bridge_default_work_dir')
      || process.env.HOME
      || '',
    model: connectionDefaults.model
      || store.getSetting('bridge_default_model')
      || '',
    mode: (connectionDefaults.mode
      || store.getSetting('bridge_default_mode')
      || 'code') as ChannelBinding['mode'],
  };
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId, address.connectionId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) return existing;
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const defaults = getBindingDefaults(address);
  const defaultCwd = workingDirectory
    || defaults.workDir;
  const defaultModel = defaults.model;
  const defaultMode = defaults.mode;
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    undefined,
    defaultCwd,
    defaultMode,
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    connectionId: address.connectionId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: defaultMode,
  });
}

/**
 * Clear the SDK session/thread reference for an existing binding so the next
 * conversation starts from a fresh provider-side context.
 */
export function clearBindingSessionContext(address: ChannelAddress): boolean {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId, address.connectionId);
  if (!existing) return false;
  store.updateChannelBinding(existing.id, { sdkSessionId: '' });
  return true;
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    connectionId: address.connectionId,
    codepilotSessionId,
    workingDirectory: session.working_directory,
    model: session.model,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * Reset an existing binding's runtime defaults to the configured values for
 * its channel/connection. Creates the binding if needed.
 */
export function resetBindingToConfiguredDefaults(address: ChannelAddress): ChannelBinding {
  const binding = resolve(address);
  const defaults = getBindingDefaults(address);
  getBridgeContext().store.updateChannelBinding(binding.id, {
    workingDirectory: defaults.workDir,
    model: defaults.model,
    mode: defaults.mode,
  });
  return getBridgeContext().store.getChannelBinding(
    address.channelType,
    address.chatId,
    address.connectionId,
  ) || binding;
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
