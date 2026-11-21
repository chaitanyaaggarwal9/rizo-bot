# Security Policy

Rizo reads and writes files and runs terminal commands on your machine, using your own API key. A bug that lets it act without your approval, leak your key, or reach outside your workspace is treated as a critical issue.

## Reporting a vulnerability

**Please do not open a public issue, pull request or discussion for security problems.**

Report vulnerabilities privately through GitHub's private vulnerability reporting:

1. Go to this repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem. If you can, include:
   - the Rizo version (Extensions view → Rizo → version),
   - the VS Code version and operating system,
   - the steps, prompt or file that trigger the issue,
   - what happened, and what you expected instead,
   - the impact, if you know it (for example: "a file outside the workspace was overwritten without a diff").

Only you and the maintainer can see the report. If you can't use GitHub, email chaitanyaaggarwal9@gmail.com instead.

## What to expect

- We aim to acknowledge reports within 5 business days.
- We will keep you informed while we investigate and fix the problem.
- Once a fix is released, we will publish a GitHub Security Advisory and credit you, unless you prefer to stay anonymous.

## Scope

In scope:

- **The Rizo VS Code extension** (`vscode-extension/`), for example:
  - a file write, edit or delete that skips the diff preview or approval,
  - a terminal command that runs without approval, or a destructive command that isn't flagged,
  - reading or writing files outside the open workspace folders without the user choosing to,
  - the OpenRouter API key leaving VS Code SecretStorage, or appearing in logs, threads, telemetry or the webview,
  - secrets in command output that aren't redacted before they reach the model,
  - script injection in the chat webview,
  - content from a file, web page or model response (prompt injection) that gets around any of the protections above.
- **The website** [rizobot.com](https://rizobot.com) (`website/`), for example script injection or a missing security header that has real impact.
- **This repository's workflows** (`.github/workflows/`), for example a way to run code with write access or publish credentials from a pull request.

Out of scope:

- Vulnerabilities in VS Code, OpenRouter, the model providers or other third-party software. Please report those to their maintainers.
- Wrong or low-quality code suggested by a model, when Rizo still showed it to you for approval.
- Problems that need an attacker to already control your machine or your VS Code settings.

## Supported versions

Only the latest version published on the Visual Studio Marketplace receives security fixes.
