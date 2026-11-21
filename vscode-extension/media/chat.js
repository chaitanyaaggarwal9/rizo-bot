// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.
//
// The chat view's script. Loaded by media/chat.html; talks to the
// extension only through acquireVsCodeApi().postMessage.
    const vscode = acquireVsCodeApi();
    // Provider catalog (providers.ts, trimmed) is embedded by getHtml() as JSON.
    // Replaced by 'catalogUpdate' after connecting your own Azure deployments.
    let PROVIDER_CATALOG = JSON.parse(document.getElementById('provider-catalog').textContent);
    const SAFE_IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]+$/i;
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('inputBox');
    const sendBtn = document.getElementById('sendBtn');
    const threadSelect = document.getElementById('threadSelect');
    const newThreadBtn = document.getElementById('newThreadBtn');
    const renameThreadBtn = document.getElementById('renameThreadBtn');
    const deleteThreadBtn = document.getElementById('deleteThreadBtn');
    const usageStatsEl = document.getElementById('usageStats');
    const modelBarEl = document.getElementById('modelBar');
    const modelPillEl = document.getElementById('modelPill');
    const modelPillLabelEl = document.getElementById('modelPillLabel');
    const modelDropdownEl = document.getElementById('modelDropdown');
    const effortPillEl = document.getElementById('effortPill');
    const effortPillLabelEl = document.getElementById('effortPillLabel');
    const effortDropdownEl = document.getElementById('effortDropdown');
    const providerPickerEl = document.getElementById('providerPicker');
    const providerGridEl = document.getElementById('providerGrid');
    const tokenStats = document.getElementById('tokenStats');
    const queueNoteEl = document.getElementById('queueNote');
    const menuBtn = document.getElementById('menuBtn');
    const menuPanelEl = document.getElementById('menuPanel');
    const changeApiKeyBtn = document.getElementById('changeApiKeyBtn');
    const openSettingsBtn = document.getElementById('openSettingsBtn');
    const sendKeySegmented = document.getElementById('sendKeySegmented');
    const focusModeSegmented = document.getElementById('focusModeSegmented');
    // Mirrors rizo.composer.sendKey / rizo.view.focusMode (real VS Code
    // settings, see sendInit) — editable from Settings UI too.
    let currentSendKey = 'enter';
    let currentFocusMode = false;
    const EFFORT_LEVELS = [
      { id: 'low', label: 'Low', tagline: 'Fast, cheapest: trivial follow-ups' },
      { id: 'medium', label: 'Medium', tagline: 'Balanced (the default)' },
      { id: 'high', label: 'High', tagline: 'Slower, priciest: hard problems' },
    ];
    // Current provider/model/effort for this thread — null/default until
    // the picker's used once. Gates sending and populates the switchers.
    let currentProvider = null;
    let currentModel = null;
    let currentEffort = 'medium';
    // Messages typed while a turn runs — send() pushes here instead of
    // dispatching immediately. dispatchNextQueued() drains one per
    // completion. Cleared (not drained) on Stop — cancel means abandon,
    // not skip ahead. Cleared on thread switch too.
    let messageQueue = [];
    // The in-flight turn's live state — null when nothing's running. Every
    // extension->webview message carries a turn id; anything not matching
    // activeTurn.id is dropped, which is what makes Stop safe without the
    // extension guaranteeing instant termination.
    let activeTurn = null;

    function formatCost(cost) {
      if (!cost) return '$0.00';
      return cost < 0.01 ? '<$0.01' : '$' + cost.toFixed(2);
    }

    function formatTag(model, taskType, usage, elapsedMs) {
      const parts = [model];
      if (taskType) parts.push(taskType);
      if (usage && usage.totalTokens) parts.push(usage.totalTokens.toLocaleString() + ' tokens');
      if (typeof elapsedMs === 'number') parts.push((elapsedMs / 1000).toFixed(1) + 's');
      return parts.join('  ·  ');
    }

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Hand-rolled, dependency-free markdown subset — code blocks, inline
    // code, bold/italic, lists, headers (flattened to bold; a real <h1>
    // reads oversized in a chat bubble). No link/image syntax — avoids an
    // injection vector. Escaping happens first, and code spans are
    // placeholder-protected so emphasis regexes never fire inside them —
    // what stands between this and XSS in model output.
    function renderMarkdown(raw) {
      // Code is swapped out for placeholders while the rest is formatted,
      // then put back. The placeholders are wrapped in NUL characters,
      // which can't appear in the text (they're stripped first) and don't
      // depend on surrounding spaces, so list items and headings that
      // start with code render correctly.
      let text = escapeHtml(String(raw).split(String.fromCharCode(0)).join(''));
      const NUL = String.fromCharCode(0);
      const NL = String.fromCharCode(10);
      const TICK = String.fromCharCode(96);
      const FENCE = TICK + TICK + TICK;

      const codeBlocks = [];
      text = text.replace(new RegExp(FENCE + '([A-Za-z0-9_-]*)' + NL + '?([^]*?)' + FENCE, 'g'), (_, _lang, code) => {
        const idx = codeBlocks.length;
        const trimmed = code.charAt(code.length - 1) === NL ? code.slice(0, -1) : code;
        codeBlocks.push('<pre><code>' + trimmed + '</code></pre>');
        return NUL + 'C' + idx + NUL;
      });

      const inlineCodes = [];
      text = text.replace(new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g'), (_, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push('<code>' + code + '</code>');
        return NUL + 'I' + idx + NUL;
      });

      text = text.replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>');
      text = text.replace(/[*]([^*]+)[*]/g, '<em>$1</em>');
      text = text.replace(/^#{1,6} +(.+)$/gm, '<span class="mdHeading">$1</span>');

      const lines = text.split(NL);
      const out = [];
      let inList = false;
      for (const line of lines) {
        const m = line.match(/^[-*] +(.+)$/);
        if (m) {
          if (!inList) { out.push('<ul>'); inList = true; }
          out.push('<li>' + m[1] + '</li>');
        } else {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push(line);
        }
      }
      if (inList) out.push('</ul>');
      text = out.join(NL);

      text = text.replace(new RegExp(NUL + '([CI])([0-9]+)' + NUL, 'g'), (_, kind, i) =>
        (kind === 'C' ? codeBlocks : inlineCodes)[Number(i)] || '');
      return text;
    }

    function setSending(isSending) {
      sendBtn.textContent = isSending ? '■' : '➤';
      sendBtn.title = isSending ? 'Stop' : 'Send';
      sendBtn.classList.toggle('stopping', isSending);
      // Stays enabled while a turn is running now — send() queues instead
      // of dispatching immediately when one's already in flight (see
      // messageQueue). Only actually disabled with no provider picked
      // yet, since there's nothing to send to at all.
      inputEl.disabled = !currentProvider;
    }

    // The one bubble a turn lives in for its whole lifecycle — same DOM
    // node throughout, never removed-and-replaced.
    // The 3-dot pulse for "Thinking…" — markup for CSS's .thinkingDot
    // animation.
    const THINKING_HTML = '<span class="thinkingDots"><span class="thinkingDot"></span><span class="thinkingDot"></span><span class="thinkingDot"></span></span>';

    // "Kimi K2 · Running write_file… · 14s · 3,420 tok". model arrives
    // once via 'turnModel'; tokens tick up via 'turnUsage'; elapsed runs
    // off a client-side timer.
    function renderTurnStatus(turn) {
      const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(0) + 's';
      const parts = [];
      if (turn.turnModel) {
        const p = findProvider(currentProvider);
        const variant = p && p.variants.find((v) => v.id === turn.turnModel);
        parts.push(variant ? p.label + ' · ' + variant.label : turn.turnModel);
      }
      parts.push(turn.currentAction);
      parts.push(elapsed);
      if (turn.liveTokens) parts.push(turn.liveTokens.toLocaleString() + ' tok');
      turn.statusEl.textContent = parts.join('  ·  ');
    }

    function startTurn(turnId) {
      const el = document.createElement('div');
      el.className = 'msg assistant pending';
      const statusEl = document.createElement('div');
      statusEl.className = 'turnStatus';
      const transcriptEl = document.createElement('div');
      transcriptEl.className = 'transcript';
      const textEl = document.createElement('span');
      textEl.className = 'streamedText';
      textEl.innerHTML = THINKING_HTML;
      el.appendChild(statusEl);
      el.appendChild(transcriptEl);
      el.appendChild(textEl);
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // bufferEl holds streamed text, created lazily on first delta — kept
      // separate from .streamCursor so new text never clobbers the cursor
      // node.
      activeTurn = {
        id: turnId, el, transcriptEl, textEl, bufferEl: null, toolLines: new Map(), textBuffer: '', hasText: false,
        statusEl, startedAt: Date.now(), turnModel: null, liveTokens: 0, currentAction: 'Thinking…',
      };
      renderTurnStatus(activeTurn);
      // Elapsed needs a live tick even when nothing else changes — a fresh
      // render every second is cheap.
      activeTurn.statusTimer = setInterval(() => renderTurnStatus(activeTurn), 1000);
      return activeTurn;
    }

    // Every path that stops a turn — finish, Stop, error, switching away —
    // must go through this, or statusTimer keeps ticking against a
    // detached turn.
    function stopTurnStatusTimer(turn) {
      if (turn && turn.statusTimer) clearInterval(turn.statusTimer);
    }

    // Classic LCS line diff. old/new are capped by DIFF_MAX_CHARS, but a
    // char cap can still hide a huge line count (20000 blank lines =
    // 20000 chars) — the DP table is O(n*m) in lines. buildDiffView's
    // a.length*b.length guard is the real backstop.
    function diffLines(oldText, newText) {
      const a = oldText.split('\n');
      const b = newText.split('\n');
      const n = a.length, m = b.length;
      const dp = [];
      for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const ops = [];
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i] }); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i++; }
        else { ops.push({ type: 'add', text: b[j] }); j++; }
      }
      while (i < n) { ops.push({ type: 'del', text: a[i] }); i++; }
      while (j < m) { ops.push({ type: 'add', text: b[j] }); j++; }
      return ops;
    }

    function diffLine(type, text) {
      const line = document.createElement('div');
      line.className = 'diffLine diff' + (type === 'add' ? 'Add' : type === 'del' ? 'Del' : 'Ctx');
      const marker = document.createElement('span');
      marker.className = 'diffMarker';
      marker.textContent = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
      const text_ = document.createElement('span');
      text_.className = 'diffText';
      text_.textContent = text;
      line.appendChild(marker);
      line.appendChild(text_);
      return line;
    }

    // diffOld undefined/empty means "new file" (write_file with nothing
    // to diff against) — every line renders as added, no LCS needed.
    function buildDiffView(oldText, newText) {
      const wrap = document.createElement('div');
      wrap.className = 'diffBlock';
      if (!oldText) {
        newText.split('\n').forEach((t) => wrap.appendChild(diffLine('add', t)));
        return wrap;
      }
      const a = oldText.split('\n');
      const b = newText.split('\n');
      if (a.length * b.length > 250000) {
        // Too large to line-diff cheaply — falls back to plain before/after
        // text rather than either freezing on the DP table or silently
        // showing nothing.
        const pre = document.createElement('pre');
        pre.textContent = '--- before ---\n' + oldText + '\n--- after ---\n' + newText;
        wrap.appendChild(pre);
        return wrap;
      }
      for (const op of diffLines(oldText, newText)) wrap.appendChild(diffLine(op.type, op.text));
      return wrap;
    }

    // Builds one tool-call's two-tier card. bodyEl only gets an IN block
    // now (if this call has detail — read/write/edit have none, the path
    // in the title already says it all); handleToolEnd appends the OUT
    // block once the result's back. Starts collapsed; the header is a
    // <button> so it's keyboard-toggleable too, not just a click target.
    function handleToolStart(turnId, callId, label, title, detail, diffOld, diffNew, isNewFile) {
      if (activeTurn && activeTurn.id === turnId && activeTurn.hasText) activeTurn.needsBreak = true;
      if (!activeTurn || activeTurn.id !== turnId) return;
      // A write/edit's diff opens automatically — the one thing worth
      // reading shouldn't need an extra click. Reads/commands stay
      // collapsed.
      const hasDiff = diffNew !== undefined;
      const card = document.createElement('div');
      card.className = hasDiff ? 'toolCard running expanded' : 'toolCard running';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'toolHeader';
      header.innerHTML =
        '<span class="toolStatus"></span>' +
        '<span class="toolLabel"></span>' +
        '<span class="toolTitle"></span>' +
        '<span class="toolChevron">▸</span>';
      header.querySelector('.toolLabel').textContent = label;
      header.querySelector('.toolTitle').textContent = title;

      const body = document.createElement('div');
      body.className = 'toolBody';
      body.hidden = !hasDiff;
      // Edit/write calls under DIFF_MAX_CHARS (tools.ts) get a real +/-
      // diff here instead of flat IN text — the native vscode.diff view at
      // approval time is gone by the time anyone scrolls back.
      if (hasDiff) {
        const block = document.createElement('div');
        block.className = 'toolBodyBlock';
        const tag = document.createElement('span');
        tag.className = 'toolBodyTag';
        tag.textContent = isNewFile ? 'NEW FILE' : 'DIFF';
        block.appendChild(tag);
        block.appendChild(buildDiffView(diffOld, diffNew));
        body.appendChild(block);
      } else if (detail) {
        const block = document.createElement('div');
        block.className = 'toolBodyBlock';
        const tag = document.createElement('span');
        tag.className = 'toolBodyTag';
        tag.textContent = 'IN';
        const pre = document.createElement('pre');
        pre.textContent = detail;
        block.appendChild(tag);
        block.appendChild(pre);
        body.appendChild(block);
      }

      header.addEventListener('click', () => {
        card.classList.toggle('expanded');
        body.hidden = !card.classList.contains('expanded');
      });

      card.appendChild(header);
      card.appendChild(body);
      activeTurn.transcriptEl.appendChild(card);
      activeTurn.toolLines.set(callId, { card, body });
      // Surfaces "what's it doing right now" at a glance, without opening
      // a card.
      activeTurn.currentAction = title || label;
      renderTurnStatus(activeTurn);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function handleToolEnd(turnId, callId, ok, resultDetail) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      const entry = activeTurn.toolLines.get(callId);
      if (!entry) return;
      entry.card.classList.remove('running');
      if (!ok) entry.card.classList.add('failed');

      if (resultDetail) {
        const block = document.createElement('div');
        block.className = 'toolBodyBlock';
        const tag = document.createElement('span');
        tag.className = 'toolBodyTag';
        tag.textContent = 'OUT';
        const pre = document.createElement('pre');
        pre.textContent = resultDetail;
        block.appendChild(tag);
        block.appendChild(pre);
        entry.body.appendChild(block);
      }
      // Back to a generic status until the next tool call or text stream
      // starts.
      activeTurn.currentAction = 'Thinking…';
      renderTurnStatus(activeTurn);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function handleTextDelta(turnId, text) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      if (!activeTurn.hasText) {
        activeTurn.textBuffer = '';
        activeTurn.hasText = true;
        // First real token — swap thinking-dots for the streamed-content
        // span plus a blinking cursor.
        activeTurn.textEl.innerHTML = '<span class="streamedContent"></span><span class="streamCursor"></span>';
        activeTurn.bufferEl = activeTurn.textEl.querySelector('.streamedContent');
        activeTurn.currentAction = 'Writing reply…';
        renderTurnStatus(activeTurn);
      }
      // Text from a new step (after a tool call) starts a new paragraph
      // instead of running into the previous step's text.
      if (activeTurn.needsBreak && activeTurn.textBuffer) activeTurn.textBuffer += String.fromCharCode(10, 10);
      activeTurn.needsBreak = false;
      activeTurn.textBuffer += text;
      activeTurn.bufferEl.textContent = activeTurn.textBuffer;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Clears partial streamed text before the next fallback model's
    // attempt, so the two don't visually run together.
    function handleTextReset(turnId) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      activeTurn.textBuffer = '';
      activeTurn.hasText = false;
      activeTurn.bufferEl = null;
      activeTurn.textEl.innerHTML = THINKING_HTML;
      activeTurn.currentAction = 'Thinking…';
      renderTurnStatus(activeTurn);
    }

    // Swaps streamed text for rendered markdown once, using the server's
    // final string rather than the client's concatenated deltas — a
    // dropped/reordered delta can't cause drift.
    function finalizeTurn(turnId, replyText, model, taskType, usage, elapsedMs, escalationModel, escalationLabel) {
      if (!activeTurn || activeTurn.id !== turnId) return;
      const turn = activeTurn;
      turn.el.classList.remove('pending');
      // The live status line's job ends here — formatTag below covers the
      // same ground permanently. Removed before model-tag insertion so
      // turn.el.firstChild is back to transcriptEl.
      stopTurnStatusTimer(turn);
      turn.statusEl.remove();
      if (model) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = formatTag(model, taskType, usage, elapsedMs);
        const br = document.createElement('br');
        turn.el.insertBefore(br, turn.el.firstChild);
        turn.el.insertBefore(tag, br);
      }
      turn.textEl.innerHTML = renderMarkdown(replyText || '');
      // Live-only affordance — not part of the persisted transcript. One
      // click re-locks the thread via the same 'selectModel' path the
      // switcher uses, then resends.
      if (escalationModel && escalationLabel) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'retryEscalateBtn';
        retryBtn.textContent = '↑ Retry with ' + escalationLabel;
        retryBtn.addEventListener('click', () => {
          retryBtn.disabled = true;
          retryBtn.textContent = 'Retrying with ' + escalationLabel + '…';
          vscode.postMessage({ type: 'selectModel', model: escalationModel });
          const retryText = 'Please try that again with more capability. Take another look and finish it properly.';
          addMessage('user', retryText);
          if (activeTurn) {
            messageQueue.push({ text: retryText, attachments: [] });
            renderQueueNote();
          } else {
            dispatchTurn(retryText, []);
          }
        });
        turn.el.appendChild(document.createElement('br'));
        turn.el.appendChild(retryBtn);
      }
      activeTurn = null;
      dispatchNextQueued();
    }

    // content is a plain string or an array of parts ({type:'text'} /
    // {type:'image_url'}) — same shape as stored messages, so history
    // replay and a just-sent message render identically.
    function addMessage(role, content, model, taskType, usage, elapsedMs) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      if (role === 'assistant' && model) {
        const tag = document.createElement('span');
        tag.className = 'model-tag';
        tag.textContent = formatTag(model, taskType, usage, elapsedMs);
        div.appendChild(tag);
        div.appendChild(document.createElement('br'));
      }
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'image_url') {
            // Only inline image data (what attachments produce). Anything
            // else in a stored thread, like an http: or javascript: URL,
            // is not loaded.
            const url = part.image_url && typeof part.image_url.url === 'string' ? part.image_url.url : '';
            if (!SAFE_IMAGE_DATA_URL.test(url)) continue;
            const img = document.createElement('img');
            img.className = 'attachedImg';
            img.src = url;
            div.appendChild(img);
          } else if (part.type === 'text' && part.text) {
            // Array content only happens for a user message carrying
            // attachments today — plain text, never markdown-rendered.
            const span = document.createElement('span');
            span.textContent = part.text;
            div.appendChild(span);
          }
        }
      } else if (role === 'assistant') {
        // Markdown applies to assistant replies only — never a user's own
        // pasted text, which shouldn't be reinterpreted as markup.
        const span = document.createElement('span');
        span.innerHTML = renderMarkdown(content || '');
        div.appendChild(span);
      } else {
        const span = document.createElement('span');
        span.textContent = content;
        div.appendChild(span);
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function renderThreadList(threads, activeId) {
      threadSelect.innerHTML = '';
      for (const t of threads) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        if (t.id === activeId) opt.selected = true;
        threadSelect.appendChild(opt);
      }
    }

    const emptyStateEl = document.getElementById('emptyState');

    function renderMessages(messages) {
      // Only called on a context switch, never mid-reply — safe to drop
      // the prior view's turn rather than leave Stop stuck. Queue is
      // thread-scoped too.
      stopTurnStatusTimer(activeTurn);
      activeTurn = null;
      messageQueue = [];
      renderQueueNote();
      setSending(false);
      messagesEl.innerHTML = '';
      emptyStateEl.style.display = messages.length === 0 ? 'flex' : 'none';
      messagesEl.style.display = messages.length === 0 ? 'none' : 'flex';
      for (const m of messages) {
        addMessage(m.role, m.content, m.model, m.taskType, m.totalTokens ? { totalTokens: m.totalTokens } : null);
      }
    }

    function findProvider(id) {
      return PROVIDER_CATALOG.find((p) => p.id === id);
    }

    // The current provider's other models from the live catalog, sent by
    // the extension after init ("More models" in the switcher).
    let moreModels = { provider: null, models: [] };

    // A curated variant or a "More models" entry, whichever has this id.
    function findModel(p, id) {
      const v = p && p.variants.find((x) => x.id === id);
      if (v) return v;
      if (p && moreModels.provider === p.id) return moreModels.models.find((m) => m.id === id) || null;
      return null;
    }

    function modelOption(id, label, detail, selected, currentModel) {
      const btn = document.createElement('button');
      btn.className = 'variantOption';
      const labelRow = document.createElement('span');
      labelRow.className = 'vLabel';
      labelRow.textContent = label;
      if (selected) {
        const check = document.createElement('span');
        check.className = 'vCheck';
        check.textContent = '✓';
        labelRow.appendChild(check);
      }
      const tagline = document.createElement('span');
      tagline.className = 'vTagline';
      tagline.textContent = detail;
      btn.appendChild(labelRow);
      btn.appendChild(tagline);
      btn.addEventListener('click', () => {
        modelDropdownEl.classList.remove('open');
        if (id !== currentModel) vscode.postMessage({ type: 'selectModel', model: id });
      });
      return btn;
    }

    // Built once — the providers never change at runtime, only which
    // one this thread has picked does.
    function renderProviderGrid() {
      providerGridEl.innerHTML = '';
      for (const p of PROVIDER_CATALOG) {
        const btn = document.createElement('button');
        btn.className = 'providerOption';
        btn.textContent = p.label;
        const tag = document.createElement('span');
        tag.className = 'pTagline';
        tag.textContent =
          p.id === 'free'
            ? 'No cost, best-effort quality'
            : p.connectable
              ? (p.variants.length ? 'Your deployments, your key' : 'Connect your Azure resource')
              : p.variants[0].label + ' to start';
        btn.appendChild(tag);
        btn.addEventListener('click', () => vscode.postMessage({ type: 'selectProvider', provider: p.id }));
        providerGridEl.appendChild(btn);
      }
    }

    // Rebuilds the switcher for this thread's locked provider — reads only
    // that provider's variants, never the full catalog, so no code path
    // can render a different company's models.
    function renderModelSwitch(provider, model) {
      if (!provider) {
        modelBarEl.style.visibility = 'hidden';
        return;
      }
      modelBarEl.style.visibility = 'visible';
      const p = findProvider(provider);
      const current = findModel(p, model);
      const fallbackLabel = model ? model.split('/').pop() : '';
      // "Claude · Opus 5.5", not "Claude · Claude Opus 5.5" for catalog names.
      let shown = current ? current.label : fallbackLabel;
      if (p && shown.toLowerCase().startsWith(p.label.toLowerCase() + ' ')) shown = shown.slice(p.label.length + 1);
      modelPillLabelEl.textContent = p ? p.label + ' · ' + shown : '';

      modelDropdownEl.innerHTML = '';
      if (!p) return;
      for (const v of p.variants) {
        modelDropdownEl.appendChild(modelOption(v.id, v.label, v.tagline, v.id === model, model));
      }
      const extra = moreModels.provider === p.id ? moreModels.models : [];
      if (extra.length) {
        const heading = document.createElement('div');
        heading.className = 'moreModelsHeading';
        heading.textContent = 'More ' + p.label + ' models';
        modelDropdownEl.appendChild(heading);
        for (const m of extra) {
          modelDropdownEl.appendChild(modelOption(m.id, m.label, m.detail, m.id === model, model));
        }
      }
    }

    // Hidden entirely (not disabled) when the variant's reasoning flag is
    // false — Effort has no server-side effect there, so showing a dead
    // control would be worse than not showing it.
    function renderEffortSwitch(provider, model, effort) {
      const p = findProvider(provider);
      const variant = findModel(p, model);
      const supported = !!variant && variant.reasoning !== false;
      effortPillEl.parentElement.style.display = supported ? '' : 'none';
      if (!supported) return;

      const current = EFFORT_LEVELS.find((e) => e.id === effort) || EFFORT_LEVELS[1];
      effortPillLabelEl.textContent = 'Effort: ' + current.label;

      effortDropdownEl.innerHTML = '';
      for (const e of EFFORT_LEVELS) {
        const btn = document.createElement('button');
        btn.className = 'variantOption';
        const labelRow = document.createElement('span');
        labelRow.className = 'vLabel';
        labelRow.textContent = e.label;
        if (e.id === effort) {
          const check = document.createElement('span');
          check.className = 'vCheck';
          check.textContent = '✓';
          labelRow.appendChild(check);
        }
        const tagline = document.createElement('span');
        tagline.className = 'vTagline';
        tagline.textContent = e.tagline;
        btn.appendChild(labelRow);
        btn.appendChild(tagline);
        btn.addEventListener('click', () => {
          effortDropdownEl.classList.remove('open');
          if (e.id !== effort) vscode.postMessage({ type: 'selectEffort', effort: e.id });
        });
        effortDropdownEl.appendChild(btn);
      }
    }

    // Single entry point for thread provider/model/effort state — keeps
    // the picker, pills, dropdowns, and composer in sync.
    function applyProviderState(provider, model, effort) {
      currentProvider = provider || null;
      currentModel = model || null;
      currentEffort = effort || 'medium';
      providerPickerEl.classList.toggle('visible', !currentProvider);
      // renderMessages() already set emptyState/messages visibility from
      // message count — override only for "no provider yet", so the
      // picker doesn't compete with the empty-state hint.
      if (!currentProvider) {
        emptyStateEl.style.display = 'none';
        messagesEl.style.display = 'none';
      }
      renderModelSwitch(currentProvider, currentModel);
      renderEffortSwitch(currentProvider, currentModel, currentEffort);
      setSending(false);
    }

    modelPillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      effortDropdownEl.classList.remove('open');
      modelDropdownEl.classList.toggle('open');
    });
    effortPillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.toggle('open');
    });
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.remove('open');
      menuPanelEl.classList.toggle('open');
    });
    menuPanelEl.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('click', () => {
      modelDropdownEl.classList.remove('open');
      effortDropdownEl.classList.remove('open');
      menuPanelEl.classList.remove('open');
    });

    function renderSettingsState(sendKey, focusMode) {
      currentSendKey = sendKey || 'enter';
      currentFocusMode = !!focusMode;
      for (const btn of sendKeySegmented.children) {
        btn.classList.toggle('active', btn.dataset.value === currentSendKey);
      }
      for (const btn of focusModeSegmented.children) {
        btn.classList.toggle('active', btn.dataset.value === (currentFocusMode ? 'on' : 'off'));
      }
      document.body.classList.toggle('focusMode', currentFocusMode);
      inputEl.placeholder = currentSendKey === 'ctrlEnter'
        ? 'Message... (Ctrl/Cmd+Enter to send, Enter for a new line)'
        : 'Message... (Enter to send, Shift+Enter for a new line)';
    }

    changeApiKeyBtn.addEventListener('click', () => {
      menuPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'changeApiKey' });
    });
    openSettingsBtn.addEventListener('click', () => {
      menuPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'openExtensionSettings' });
    });
    sendKeySegmented.addEventListener('click', (e) => {
      const btn = e.target.closest('.segmentedOption');
      if (!btn || btn.dataset.value === currentSendKey) return;
      vscode.postMessage({ type: 'setSendKey', value: btn.dataset.value });
    });
    focusModeSegmented.addEventListener('click', (e) => {
      const btn = e.target.closest('.segmentedOption');
      if (!btn) return;
      const wantsOn = btn.dataset.value === 'on';
      if (wantsOn === currentFocusMode) return;
      vscode.postMessage({ type: 'setFocusMode', value: wantsOn });
    });

    function renderUsageStats(dayTokens, monthCost) {
      usageStatsEl.textContent = 'Today: ' + (dayTokens || 0).toLocaleString() + ' tok  ·  Month: ' + formatCost(monthCost);
    }

    function renderThreadStats(totalTokens, totalCost) {
      if (!totalTokens) { tokenStats.textContent = ''; return; }
      tokenStats.textContent = 'Total this chat: ' + totalTokens.toLocaleString() + ' tokens  ·  ' + formatCost(totalCost);
    }

    function autoGrow() {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
    }
    inputEl.addEventListener('input', autoGrow);

    // --- Attachments ---
    const attachBtn = document.getElementById('attachBtn');
    const attachMenu = document.getElementById('attachMenu');
    const attachFileOption = document.getElementById('attachFileOption');
    const attachWorkspaceOption = document.getElementById('attachWorkspaceOption');
    const attachmentChipsEl = document.getElementById('attachmentChips');
    let pendingAttachments = [];

    function renderChips() {
      attachmentChipsEl.innerHTML = '';
      pendingAttachments.forEach((att, i) => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        if (att.type === 'image') {
          const img = document.createElement('img');
          img.src = 'data:' + att.mimeType + ';base64,' + att.content;
          chip.appendChild(img);
        } else {
          const icon = document.createElement('span');
          icon.className = 'chipIcon';
          icon.textContent = '▤';
          chip.appendChild(icon);
        }
        const name = document.createElement('span');
        name.className = 'chipName';
        name.textContent = att.name;
        name.title = att.name;
        chip.appendChild(name);
        const remove = document.createElement('button');
        remove.className = 'chipRemove';
        remove.textContent = '×';
        remove.title = 'Remove';
        remove.addEventListener('click', () => {
          pendingAttachments.splice(i, 1);
          renderChips();
        });
        chip.appendChild(remove);
        attachmentChipsEl.appendChild(chip);
      });
    }

    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachMenu.classList.toggle('open');
    });
    document.addEventListener('click', () => attachMenu.classList.remove('open'));
    attachFileOption.addEventListener('click', () => {
      attachMenu.classList.remove('open');
      vscode.postMessage({ type: 'attachFile' });
    });
    attachWorkspaceOption.addEventListener('click', () => {
      attachMenu.classList.remove('open');
      vscode.postMessage({ type: 'attachWorkspaceFile' });
    });

    // Cmd/Ctrl+V with an image on the clipboard attaches it the same way
    // "Attach file..." does. 5MB cap mirrors readAndSendAttachment's limit
    // on the extension side.
    const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024;
    inputEl.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (!file) continue;
        if (file.size > MAX_PASTED_IMAGE_BYTES) {
          addMessage('assistant', 'That pasted image is over the 5MB limit. Try a smaller one.');
          continue;
        }
        e.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const comma = dataUrl.indexOf(',');
          pendingAttachments.push({
            name: 'Pasted image',
            type: 'image',
            mimeType: file.type,
            content: dataUrl.slice(comma + 1),
          });
          renderChips();
        };
        reader.readAsDataURL(file);
      }
    });

    function renderQueueNote() {
      queueNoteEl.textContent = messageQueue.length
        ? messageQueue.length + ' message' + (messageQueue.length > 1 ? 's' : '') + ' queued, sends once this reply finishes'
        : '';
    }

    // Split out of send() so a queued item can trigger it later via
    // dispatchNextQueued() without duplicating this.
    function dispatchTurn(text, attachments) {
      const turnId = Date.now() + '-' + Math.random().toString(36).slice(2);
      startTurn(turnId);
      setSending(true);
      vscode.postMessage({ type: 'send', text, attachments, turnId });
    }

    // Called from every turn-completion path (finalizeTurn, the error
    // handler) except Stop, which clears the queue instead — see
    // messageQueue's own comment.
    function dispatchNextQueued() {
      if (messageQueue.length === 0) { setSending(false); return; }
      const next = messageQueue.shift();
      renderQueueNote();
      dispatchTurn(next.text, next.attachments);
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      emptyStateEl.style.display = 'none';
      messagesEl.style.display = 'flex';

      const displayContent = pendingAttachments.length
        ? [{ type: 'text', text }, ...pendingAttachments.filter((a) => a.type === 'image').map((a) => ({
            type: 'image_url', image_url: { url: 'data:' + a.mimeType + ';base64,' + a.content },
          }))]
        : text;
      // Rendered immediately either way — the message landed the moment
      // you hit send; only its reply is deferred.
      addMessage('user', displayContent);

      const attachments = pendingAttachments;
      pendingAttachments = [];
      renderChips();
      inputEl.value = '';
      autoGrow();

      if (activeTurn) {
        messageQueue.push({ text, attachments });
        renderQueueNote();
        return;
      }
      dispatchTurn(text, attachments);
    }

    // sendBtn does double duty: Send when idle, Stop mid-turn (see
    // setSending). Stop finalizes the UI immediately rather than waiting
    // for the extension's 'cancelled' ack — turnId-gating below makes
    // that safe against in-flight messages arriving after.
    sendBtn.addEventListener('click', () => {
      if (activeTurn) {
        const turn = activeTurn;
        vscode.postMessage({ type: 'cancel', turnId: turn.id });
        stopTurnStatusTimer(turn);
        turn.statusEl.remove();
        const stoppedEl = document.createElement('div');
        stoppedEl.className = 'stoppedNote';
        stoppedEl.textContent = 'Stopped.';
        turn.el.appendChild(stoppedEl);
        turn.el.classList.remove('pending');
        activeTurn = null;
        // Stop clears anything queued too — cancel means abandon, not
        // skip ahead.
        messageQueue = [];
        renderQueueNote();
        setSending(false);
        return;
      }
      send();
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // rizo.composer.sendKey: 'enter' sends on plain Enter, Shift+Enter
      // for a newline. 'ctrlEnter' flips that, for multi-line prompt
      // writers.
      const wantsSend = currentSendKey === 'ctrlEnter' ? e.ctrlKey || e.metaKey : !e.shiftKey;
      if (!wantsSend) return;
      e.preventDefault();
      send();
    });
    newThreadBtn.addEventListener('click', () => vscode.postMessage({ type: 'newThread' }));
    renameThreadBtn.addEventListener('click', () => {
      menuPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'renameThread' });
    });
    deleteThreadBtn.addEventListener('click', () => {
      menuPanelEl.classList.remove('open');
      vscode.postMessage({ type: 'deleteThread' });
    });
    threadSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'switchThread', id: threadSelect.value });
    });

    window.addEventListener('message', (event) => {
      // Messages come from the extension through VS Code's webview host.
      // Ignore anything from another origin and anything without a type.
      // (VS Code relays them from a frame with the same origin as this one.)
      const origin = typeof event.origin === 'string' ? event.origin : '';
      if (origin && origin !== window.location.origin && !origin.startsWith('vscode-webview://')) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      if (msg.type === 'init') {
        renderThreadList(msg.threads, msg.activeThreadId);
        renderMessages(msg.messages);
        applyProviderState(msg.provider, msg.model, msg.effort);
        renderThreadStats(msg.threadTokens, msg.threadCost);
        renderUsageStats(msg.dayTokens, msg.monthCost);
        renderSettingsState(msg.sendKey, msg.focusMode);
        return;
      }
      if (msg.type === 'threadListUpdated') {
        renderThreadList(msg.threads, msg.activeThreadId);
        return;
      }
      if (msg.type === 'settingsUpdate') {
        // Deliberately not renderMessages()/applyProviderState() here —
        // see sendSettingsUpdate's comment. A settings change mid-turn
        // must never touch activeTurn or the message queue.
        renderSettingsState(msg.sendKey, msg.focusMode);
        return;
      }
      if (msg.type === 'stateUpdate') {
        // Model, effort or name changed (possibly mid-turn). Unlike init,
        // this leaves the message list, the live turn and the queue alone.
        renderThreadList(msg.threads, msg.activeThreadId);
        currentProvider = msg.provider || null;
        currentModel = msg.model || null;
        currentEffort = msg.effort || 'medium';
        renderModelSwitch(currentProvider, currentModel);
        renderEffortSwitch(currentProvider, currentModel, currentEffort);
        renderThreadStats(msg.threadTokens, msg.threadCost);
        renderUsageStats(msg.dayTokens, msg.monthCost);
        return;
      }
      if (msg.type === 'catalogUpdate') {
        if (Array.isArray(msg.catalog)) {
          PROVIDER_CATALOG = msg.catalog.filter((p) => p && typeof p.id === 'string' && typeof p.label === 'string' && Array.isArray(p.variants));
          renderProviderGrid();
          renderModelSwitch(currentProvider, currentModel);
          renderEffortSwitch(currentProvider, currentModel, currentEffort);
        }
        return;
      }
      if (msg.type === 'moreModels') {
        moreModels = {
          provider: typeof msg.provider === 'string' ? msg.provider : null,
          models: Array.isArray(msg.models)
            ? msg.models.filter((m) => m && typeof m.id === 'string' && typeof m.label === 'string')
            : [],
        };
        renderModelSwitch(currentProvider, currentModel);
        renderEffortSwitch(currentProvider, currentModel, currentEffort);
        return;
      }
      if (msg.type === 'attachmentAdded') {
        pendingAttachments.push(msg.attachment);
        renderChips();
        return;
      }
      if (msg.type === 'prefillComposer') {
        inputEl.value = msg.text;
        autoGrow();
        inputEl.focus();
        return;
      }

      // Everything below belongs to one in-flight turn — drop it if it's
      // not (or no longer) the active one.
      if (!activeTurn || msg.turnId !== activeTurn.id) return;

      if (msg.type === 'toolStart') {
        handleToolStart(msg.turnId, msg.callId, msg.label, msg.title, msg.detail, msg.diffOld, msg.diffNew, msg.isNewFile);
      } else if (msg.type === 'toolEnd') {
        handleToolEnd(msg.turnId, msg.callId, msg.ok, msg.resultDetail);
      } else if (msg.type === 'textDelta') {
        handleTextDelta(msg.turnId, msg.text);
      } else if (msg.type === 'textReset') {
        handleTextReset(msg.turnId);
      } else if (msg.type === 'reply') {
        finalizeTurn(msg.turnId, msg.reply, msg.model, msg.taskType, msg.usage, msg.elapsedMs, msg.escalationModel, msg.escalationLabel);
        renderThreadStats(msg.threadTokens, msg.threadCost);
        renderUsageStats(msg.dayTokens, msg.monthCost);
        // Catches the pills up if model/effort silently changed (Smart
        // Starting Variant, effort auto-suggestion) — otherwise they'd
        // show a stale value until the next full re-render.
        const modelChanged = msg.currentModel && msg.currentModel !== currentModel;
        const effortChanged = msg.currentEffort && msg.currentEffort !== currentEffort;
        if (modelChanged) currentModel = msg.currentModel;
        if (effortChanged) currentEffort = msg.currentEffort;
        if (modelChanged || effortChanged) {
          renderModelSwitch(currentProvider, currentModel);
          renderEffortSwitch(currentProvider, currentModel, currentEffort);
        }
      } else if (msg.type === 'turnModel') {
        activeTurn.turnModel = msg.model;
        renderTurnStatus(activeTurn);
      } else if (msg.type === 'turnUsage') {
        activeTurn.liveTokens = msg.totalTokens;
        renderTurnStatus(activeTurn);
      } else if (msg.type === 'error') {
        const turn = activeTurn;
        stopTurnStatusTimer(turn);
        activeTurn = null;
        if (turn.toolLines.size > 0 || turn.hasText) {
          // Keep what already happened (tool cards, applied diffs, partial
          // text) visible and add the error below it, so it's clear which
          // changes were made before things went wrong.
          turn.el.classList.remove('pending');
          turn.statusEl.remove();
          if (turn.hasText) {
            const cursor = turn.textEl.querySelector('.streamCursor');
            if (cursor) cursor.remove();
          } else {
            turn.textEl.remove();
          }
          const errorEl = document.createElement('div');
          errorEl.className = 'turnError';
          errorEl.textContent = 'Error: ' + msg.error;
          turn.el.appendChild(errorEl);
        } else {
          turn.el.remove();
          addMessage('assistant', 'Error: ' + msg.error);
        }
        dispatchNextQueued();
      }
      // 'cancelled' needs no handling — the local Stop click already
      // finalized the UI; this is just the extension's confirmation.
    });

    renderProviderGrid();
    vscode.postMessage({ type: 'ready' });
