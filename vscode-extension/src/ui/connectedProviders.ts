// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Providers the user connects with their own cloud key (not OpenRouter).
// The chat panel treats them all the same way through this table: show a
// card in the picker, connect on first use, list the user's models, call
// with the user's key.

import * as vscode from 'vscode';
import { callAzure } from '../api/azure';
import { callBedrock } from '../api/bedrock';
import { CallOptions, ChatMessage, ChatResult } from '../api/openrouter';
import { ToolDefinition } from '../tools/tools';
import { connectAzure, disconnectAzure, getAzureConnection, getAzureKey } from './azureConnect';
import { connectBedrock, disconnectBedrock, getBedrockConnection, getBedrockKey } from './bedrockConnect';

export interface ConnectedProvider {
  id: string;
  label: string;
  connectCommandTitle: string;
  modelTagline: string;
  // Whether the Effort control is sent (Azure: reasoning_effort). Bedrock's
  // reasoning settings differ per model family, so it's hidden there.
  supportsEffort: boolean;
  // Errors meaning the stored key no longer works.
  authError: RegExp;
  models(context: vscode.ExtensionContext): string[] | undefined;
  getKey(context: vscode.ExtensionContext): Promise<string | undefined>;
  connect(context: vscode.ExtensionContext): Promise<boolean>;
  disconnect(context: vscode.ExtensionContext): Promise<void>;
  call(
    context: vscode.ExtensionContext,
    apiKey: string,
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: CallOptions,
  ): Promise<ChatResult>;
}

const notConnected = (label: string, command: string) => new Error(`${label} is no longer connected. Run "${command}".`);

export const CONNECTED_PROVIDERS: Record<string, ConnectedProvider> = {
  azure: {
    id: 'azure',
    label: 'Azure AI Foundry',
    connectCommandTitle: 'Rizo: Connect Azure AI Foundry',
    modelTagline: 'Your Azure deployment',
    supportsEffort: true,
    authError: /401|403|unauthorized|access denied|invalid subscription key/i,
    models: (c) => getAzureConnection(c)?.deployments,
    getKey: getAzureKey,
    connect: async (c) => !!(await connectAzure(c)),
    disconnect: disconnectAzure,
    call: (c, key, model, messages, tools, options) => {
      const conn = getAzureConnection(c);
      if (!conn) throw notConnected('Azure AI Foundry', 'Rizo: Connect Azure AI Foundry');
      return callAzure(conn, key, model, messages, tools, { ...options, maxTokensFor: undefined });
    },
  },
  bedrock: {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    connectCommandTitle: 'Rizo: Connect Amazon Bedrock',
    modelTagline: 'Your Bedrock model',
    supportsEffort: false,
    authError: /401|403|unauthorized|not authorized|invalid.*(token|key)|expired|security token/i,
    models: (c) => getBedrockConnection(c)?.models,
    getKey: getBedrockKey,
    connect: async (c) => !!(await connectBedrock(c)),
    disconnect: disconnectBedrock,
    call: (c, key, model, messages, tools, options) => {
      const conn = getBedrockConnection(c);
      if (!conn) throw notConnected('Amazon Bedrock', 'Rizo: Connect Amazon Bedrock');
      return callBedrock(conn, key, model, messages, tools, { ...options, reasoningEffort: undefined, maxTokensFor: undefined });
    },
  },
};

export function getConnectedProvider(id: string | undefined): ConnectedProvider | undefined {
  return id ? CONNECTED_PROVIDERS[id] : undefined;
}

// Picker entries for the chat view, after the OpenRouter companies.
export function connectedProviderCatalog(context: vscode.ExtensionContext) {
  return Object.values(CONNECTED_PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    connectable: true,
    variants: (p.models(context) ?? []).map((m) => ({ id: m, label: m, tagline: p.modelTagline, reasoning: p.supportsEffort })),
  }));
}
