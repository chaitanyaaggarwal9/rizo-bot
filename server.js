// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { FREE_MODELS, detectTaskType } = require('./models.config');
const { loadSkillsContent } = require('./skills.config');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'model-usage.jsonl');

// Appends one JSON line per request recording which model answered — so you
// can see over time which free models are actually performing well and
// manually re-rank models.config.js later.
function logModelUsage(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    console.warn('Could not write to model usage log:', err.message);
  }
}

// Calls OpenRouter with a single model. Never throws on a non-200 response —
// callers check `ok` and move to the next model in the fallback chain.
async function callOpenRouter(model, messages) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages }),
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

// Tries the ranked free models for this task type, in order. On any error
// (including 429 rate limits) it moves to the next model; if every named
// model fails, it finally tries FREE_MODELS.fallback ("openrouter/free").
async function chatWithFallback(messages, taskType) {
  const ranked = FREE_MODELS[taskType] || FREE_MODELS.general;
  const chain = [...ranked, FREE_MODELS.fallback];
  let lastError = 'All models in the fallback chain failed';

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const { ok, status, data } = await callOpenRouter(model, messages);
      if (ok) {
        const reply = data.choices?.[0]?.message?.content ?? '';
        if (!reply.trim()) {
          // HTTP 200 but nothing useful came back — treat as a failure too,
          // not just explicit errors/429s, and fall through to the next model.
          lastError = 'model returned an empty reply';
          console.warn(`[chat] ${model} returned an empty reply — trying next`);
          continue;
        }
        return { model: data.model || model, reply, attempts: i + 1 };
      }
      lastError = data.error?.message || data.error || `HTTP ${status}`;
      console.warn(`[chat] ${model} failed (${status}): ${JSON.stringify(lastError)} — trying next`);
    } catch (err) {
      lastError = err.message;
      console.warn(`[chat] ${model} request failed: ${err.message} — trying next`);
    }
  }

  throw new Error(lastError);
}

// Single shared in-memory conversation (personal single-user assistant — no
// per-user sessions, no database). Resets on server restart, or via POST /api/reset.
let conversationHistory = [];
const MAX_HISTORY_MESSAGES = 20; // keep last ~10 user/assistant turns for context

app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Missing "message" in request body' });
  }

  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({
      error: 'OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your key.',
    });
  }

  const taskType = detectTaskType(message);
  console.log(`[chat] task type detected: ${taskType}`);

  // Only the skill files relevant to this message are loaded — general/
  // search questions get none, coding questions get the base layer plus
  // whichever specific topics (debugging, git, api, testing) match.
  const skillsContent = loadSkillsContent(message, taskType);

  const messages = [
    { role: 'system', content: skillsContent },
    ...conversationHistory,
    { role: 'user', content: message },
  ];

  try {
    const { model, reply, attempts } = await chatWithFallback(messages, taskType);

    // Log which model actually answered, so you can see how the ranked
    // free-model list is performing over time.
    console.log(`[chat] answered by: ${model} (attempt ${attempts})`);
    logModelUsage({ taskType, model, attempts });

    // Only commit to history after a successful reply, so a failed request
    // doesn't leave a dangling unanswered user message in context.
    conversationHistory.push({ role: 'user', content: message }, { role: 'assistant', content: reply });
    if (conversationHistory.length > MAX_HISTORY_MESSAGES) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    res.json({ model, reply });
  } catch (err) {
    console.error('All models failed:', err.message);
    logModelUsage({ taskType, model: null, error: err.message });
    res.status(502).json({ error: `All free models failed: ${err.message}` });
  }
});

app.post('/api/reset', (req, res) => {
  conversationHistory = [];
  console.log('[chat] conversation history reset');
  res.json({ ok: true, message: 'Conversation history cleared.' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
