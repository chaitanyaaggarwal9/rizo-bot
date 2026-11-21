// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Connecting Rizo to Amazon Bedrock with a Bedrock API key: region and
// model ids in globalState, the key in SecretStorage. Not a VS Code
// setting, so a repository's settings can't change where the key goes.

import * as vscode from 'vscode';
import { BedrockConnection, isValidBedrockModelId, isValidRegion, listBedrockModels, verifyBedrock } from '../api/bedrock';

const CONNECTION_KEY = 'rizo.bedrock.connection';
const SECRET_KEY = 'rizo.bedrock.apiKey';

export function getBedrockConnection(context: vscode.ExtensionContext): BedrockConnection | undefined {
  const c = context.globalState.get<BedrockConnection>(CONNECTION_KEY);
  if (!c || !isValidRegion(c.region) || !Array.isArray(c.models)) return undefined;
  const models = c.models.filter(isValidBedrockModelId);
  return models.length ? { region: c.region, models } : undefined;
}

export async function getBedrockKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_KEY);
}

export async function connectBedrock(context: vscode.ExtensionContext): Promise<BedrockConnection | undefined> {
  const existing = getBedrockConnection(context);
  const regionInput = await vscode.window.showInputBox({
    title: 'Connect Amazon Bedrock (1/3): region',
    prompt: 'The AWS region where you use Bedrock.',
    placeHolder: 'us-east-1',
    value: existing?.region ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (isValidRegion(v.trim()) ? undefined : 'Enter an AWS region such as us-east-1 or eu-west-3.'),
  });
  if (regionInput === undefined) return undefined;
  const region = regionInput.trim();

  const storedKey = await getBedrockKey(context);
  const keyInput = await vscode.window.showInputBox({
    title: 'Connect Amazon Bedrock (2/3): API key',
    prompt: storedKey
      ? 'Your Bedrock API key (leave empty to keep the saved one). It is stored in your OS keychain through VS Code.'
      : 'Your Bedrock API key (Bedrock console, "API keys"). It is stored in your OS keychain through VS Code.',
    password: true,
    ignoreFocusOut: true,
  });
  if (keyInput === undefined) return undefined;
  const apiKey = keyInput.trim() || storedKey;
  if (!apiKey) return undefined;

  const listed = await listBedrockModels(region, apiKey);
  const typeOption = 'Type model ids…';
  let picked: string[] = [];
  if (listed.length) {
    const choice = await vscode.window.showQuickPick(
      [...listed.map((id) => ({ label: id, picked: existing?.models.includes(id) ?? false })), { label: typeOption, picked: false }],
      {
        title: 'Connect Amazon Bedrock (3/3): models',
        placeHolder: 'Pick the models to use in Rizo (they must support tool use; newer models usually need the "us." / "eu." inference profile)',
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!choice) return undefined;
    picked = choice.filter((c) => c.label !== typeOption).map((c) => c.label);
    if (choice.some((c) => c.label === typeOption)) picked.push(...(await askModelIds(existing)));
  } else {
    picked = await askModelIds(existing);
  }
  picked = [...new Set(picked)];
  if (!picked.length) return undefined;

  const working: string[] = [];
  const failures: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking your Bedrock models…' },
    async () => {
      for (const id of picked) {
        const err = await verifyBedrock(region, apiKey, id);
        if (err) failures.push(`${id}: ${err}`);
        else working.push(id);
      }
    },
  );
  if (!working.length) {
    void vscode.window.showErrorMessage(`Rizo couldn't use any of those Bedrock models. ${failures.join(' ')}`);
    return undefined;
  }

  const connection: BedrockConnection = { region, models: working };
  await context.secrets.store(SECRET_KEY, apiKey);
  await context.globalState.update(CONNECTION_KEY, connection);
  void vscode.window.showInformationMessage(
    `Connected to Amazon Bedrock (${region}) with ${working.length} model${working.length === 1 ? '' : 's'}.` +
      (failures.length ? ` Skipped: ${failures.join(' ')}` : ''),
  );
  return connection;
}

async function askModelIds(existing: BedrockConnection | undefined): Promise<string[]> {
  const input = await vscode.window.showInputBox({
    title: 'Connect Amazon Bedrock (3/3): models',
    prompt: 'Model or inference profile ids, separated by commas (Bedrock console, "Model catalog" or "Cross-region inference").',
    placeHolder: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    value: existing?.models.join(', ') ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return 'Enter at least one model id.';
      const bad = ids.find((id) => !isValidBedrockModelId(id));
      return bad ? `"${bad}" isn't a valid Bedrock model id.` : undefined;
    },
  });
  return input ? input.split(',').map((s) => s.trim()).filter(isValidBedrockModelId) : [];
}

export async function disconnectBedrock(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_KEY);
  await context.globalState.update(CONNECTION_KEY, undefined);
  void vscode.window.showInformationMessage('Disconnected Amazon Bedrock. Your key was removed from Rizo.');
}
