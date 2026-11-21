// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Connecting Rizo to the user's Azure AI Foundry resource: endpoint and
// deployments in globalState, the key in SecretStorage. Deliberately not
// a VS Code setting: a repository's .vscode/settings.json must never be
// able to point your key at a different server.

import * as vscode from 'vscode';
import {
  AzureConnection,
  isValidDeploymentName,
  listAzureModels,
  normalizeAzureEndpoint,
  verifyAzureConnection,
} from '../api/azure';

const CONNECTION_KEY = 'rizo.azure.connection';
const SECRET_KEY = 'rizo.azure.apiKey';

export function getAzureConnection(context: vscode.ExtensionContext): AzureConnection | undefined {
  const c = context.globalState.get<AzureConnection>(CONNECTION_KEY);
  if (!c || typeof c.baseUrl !== 'string' || !Array.isArray(c.deployments)) return undefined;
  // Re-check what's stored, so a tampered value can't redirect the key.
  const normalized = normalizeAzureEndpoint(c.baseUrl);
  if (!('baseUrl' in normalized)) return undefined;
  const deployments = c.deployments.filter(isValidDeploymentName);
  return deployments.length ? { baseUrl: normalized.baseUrl, deployments } : undefined;
}

export async function getAzureKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

// Asks for endpoint, key and deployments, checks each deployment with a
// tiny request, and saves what works. Returns the connection, or
// undefined if the user cancelled or nothing worked.
export async function connectAzure(context: vscode.ExtensionContext): Promise<AzureConnection | undefined> {
  const existing = getAzureConnection(context);
  const endpointInput = await vscode.window.showInputBox({
    title: 'Connect Azure AI Foundry (1/3): endpoint',
    prompt: 'Your Azure AI Foundry or Azure OpenAI endpoint, from the resource\'s "Keys and Endpoint" page in the Azure portal.',
    placeHolder: 'https://my-resource.openai.azure.com',
    value: existing ? existing.baseUrl.replace(/\/openai\/v1$/, '') : '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const r = normalizeAzureEndpoint(v);
      return 'error' in r ? r.error : undefined;
    },
  });
  if (endpointInput === undefined) return undefined;
  const normalized = normalizeAzureEndpoint(endpointInput);
  if ('error' in normalized) return undefined;
  const baseUrl = normalized.baseUrl;

  const storedKey = await getAzureKey(context);
  const keyInput = await vscode.window.showInputBox({
    title: 'Connect Azure AI Foundry (2/3): API key',
    prompt: storedKey
      ? 'Your Azure API key (leave empty to keep the saved one). It is stored in your OS keychain through VS Code.'
      : 'Your Azure API key (KEY 1 or KEY 2). It is stored in your OS keychain through VS Code.',
    password: true,
    ignoreFocusOut: true,
  });
  if (keyInput === undefined) return undefined;
  const apiKey = keyInput.trim() || storedKey;
  if (!apiKey) return undefined;

  const listed = await listAzureModels({ baseUrl }, apiKey);
  let picked: string[] = [];
  const typeOption = 'Type deployment names…';
  if (listed.length) {
    const choice = await vscode.window.showQuickPick(
      [...listed.map((id) => ({ label: id, picked: existing?.deployments.includes(id) ?? false })), { label: typeOption, picked: false }],
      {
        title: 'Connect Azure AI Foundry (3/3): deployments',
        placeHolder: 'Pick the deployments to use in Rizo (they must support tool calling)',
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!choice) return undefined;
    picked = choice.filter((c) => c.label !== typeOption).map((c) => c.label);
    if (choice.some((c) => c.label === typeOption)) picked.push(...(await askDeploymentNames(existing)));
  } else {
    picked = await askDeploymentNames(existing);
  }
  picked = [...new Set(picked)];
  if (!picked.length) return undefined;

  const working: string[] = [];
  const failures: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking your Azure deployments…' },
    async () => {
      for (const d of picked) {
        const err = await verifyAzureConnection({ baseUrl }, apiKey, d);
        if (err) failures.push(`${d}: ${err}`);
        else working.push(d);
      }
    },
  );
  if (!working.length) {
    void vscode.window.showErrorMessage(`Rizo couldn't use any of those Azure deployments. ${failures.join(' ')}`);
    return undefined;
  }

  const connection: AzureConnection = { baseUrl, deployments: working };
  await context.secrets.store(SECRET_KEY, apiKey);
  await context.globalState.update(CONNECTION_KEY, connection);
  void vscode.window.showInformationMessage(
    `Connected to Azure AI Foundry with ${working.length} deployment${working.length === 1 ? '' : 's'}: ${working.join(', ')}.` +
      (failures.length ? ` Skipped: ${failures.join(' ')}` : ''),
  );
  return connection;
}

async function askDeploymentNames(existing: AzureConnection | undefined): Promise<string[]> {
  const input = await vscode.window.showInputBox({
    title: 'Connect Azure AI Foundry (3/3): deployments',
    prompt: 'Deployment names, separated by commas (as shown under Deployments in Azure AI Foundry). They must support tool calling.',
    placeHolder: 'gpt-5-chat, my-deepseek',
    value: existing?.deployments.join(', ') ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const names = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!names.length) return 'Enter at least one deployment name.';
      const bad = names.find((n) => !isValidDeploymentName(n));
      return bad ? `"${bad}" isn't a valid deployment name.` : undefined;
    },
  });
  return input ? input.split(',').map((s) => s.trim()).filter(isValidDeploymentName) : [];
}

export async function disconnectAzure(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  await context.globalState.update(CONNECTION_KEY, undefined);
  void vscode.window.showInformationMessage('Disconnected Azure AI Foundry. Your key was removed from Rizo.');
}
