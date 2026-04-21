// ==UserScript==
// @name         LinkedIn Signal Filter
// @namespace    https://github.com/nicgould
// @version      0.2.0
// @description  AI-powered quality filter for LinkedIn feed. Evaluates posts for genuine signal vs noise and hides low-quality content.
// @author       Nic Gould
// @match        https://www.linkedin.com/feed*
// @match        https://www.linkedin.com/feed/
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.openai.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // CONFIGURATION
  // ============================================================
  const CONFIG = {
    QUALITY_THRESHOLD: 5,
    MODEL: 'gpt-4o-mini',
    BATCH_SIZE: 5,
    DEBOUNCE_MS: 3000,
    MIN_TEXT_LENGTH: 80,
    MAX_TEXT_LENGTH: 1500,
    API_COOLDOWN_MS: 2000,
    DEBUG: true,
  };

  // ============================================================
  // STATE
  // ============================================================
  const state = {
    apiKey: null,
    queue: [],
    processing: false,
    stats: { scanned: 0, hidden: 0, shown: 0, skipped: 0, errors: 0 },
    debounceTimer: null,
    processedPosts: new WeakSet(),
    paused: false,
    reviewMode: false,
    filteredLog: [],
    drawerOpen: false,
  };

  // ============================================================
  // LOGGING
  // ============================================================
  function log(...args) {
    if (CONFIG.DEBUG) console.log('[SignalFilter]', ...args);
  }

  // ============================================================
  // EVALUATION RUBRIC
  // ============================================================
  const SYSTEM_PROMPT = `You are a content quality evaluator for a professional social media feed. Your job is to separate genuine insight from noise. You are NOT detecting AI-generated content — you are detecting whether content contains real signal regardless of how it was produced.

Score each post on four dimensions (1-5 each):

SPECIFICITY (1-5)
Does the post make concrete, specific claims or observations?
1 = Pure generality ("AI is transforming everything", "leaders need to adapt")
2 = Mostly general with one vague specific reference
3 = Some specific references but general framing dominates
4 = Mostly specific claims, named technologies/methods/outcomes
5 = Concrete, falsifiable claims with specific examples, data, or named systems

ORIGINAL_REASONING (1-5)
Does the post develop an argument or just restate/assemble known positions?
1 = Listicle of talking points, no argument development, purely assembled
2 = Has a thesis but supports it only with assertion
3 = A point of view with some supporting logic
4 = Builds a genuine argument where points develop on each other
5 = Derives novel conclusions, makes connections others haven't, reasoning is the point

EXPERIENTIAL_GROUNDING (1-5)
Does the author draw on specific first-hand experience?
1 = No indication of personal experience, could be written by anyone about anything
2 = Vague appeal to experience ("in my years of...")
3 = References own work/domain but without revealing detail
4 = Specific references to things built, encountered, or observed
5 = Detailed first-hand account with specifics that would be hard to fabricate

EPISTEMIC_HONESTY (1-5)
Does the post acknowledge limitations, tradeoffs, or uncertainty?
1 = Pure assertion, promotional tone, no qualification whatsoever
2 = Token hedging ("of course it depends") without substance
3 = Acknowledges some limitations but mostly one-sided
4 = Genuine engagement with counterarguments or tradeoffs
5 = Actively identifies what they don't know, where their argument is weakest

OVERALL (1-10)
Holistic quality score. A post can score well overall even if weak on one dimension if exceptionally strong on others. A short post can score well if it's a single genuinely sharp insight. Promotional content, engagement bait, motivational platitudes, and repackaged conventional wisdom should score low regardless of production quality.

Scoring guidance for edge cases:
- Job announcements, congratulations, personal milestones: score 3 (neutral, not noise but not signal)
- Genuine questions that frame a problem well: score based on the quality of the framing
- Contrarian takes: score on whether the contrarian position is actually argued, not just asserted
- Short posts (<3 sentences): can still score high if the insight is sharp and specific

REASON: One brief sentence explaining the overall score.

Respond with ONLY a valid JSON array. No markdown, no backticks, no preamble:
[{"id": "post_0", "specificity": N, "original_reasoning": N, "experiential_grounding": N, "epistemic_honesty": N, "overall": N, "reason": "..."}]`;

  // ============================================================
  // API KEY MANAGEMENT
  // ============================================================
  async function getApiKey() {
    let key = await GM_getValue('openai_api_key', null);
    if (!key) {
      key = prompt(
        'LinkedIn Signal Filter\n\n' +
        'Enter your OpenAI API key to enable feed quality filtering.\n' +
        'Stored locally in Tampermonkey, only sent to OpenAI.\n\n' +
        'API Key:'
      );
      if (key && key.startsWith('sk-')) {
        await GM_setValue('openai_api_key', key);
      } else {
        return null;
      }
    }
    return key;
  }

  GM_registerMenuCommand('Set API Key', async () => {
    const key = prompt('Enter OpenAI API key:');
    if (key && key.startsWith('sk-')) {
      await GM_setValue('openai_api_key', key);
      state.apiKey = key;
    }
  });

  GM_registerMenuCommand('Set Quality Threshold', () => {
    const val = prompt(`Current: ${CONFIG.QUALITY_THRESHOLD}\nNew threshold (1-10):`, CONFIG.QUALITY_THRESHOLD);
    const num = parseInt(val, 10);
    if (num >= 1 && num <= 10) {
      CONFIG.QUALITY_THRESHOLD = num;
      updatePanel();
    }
  });

  // ============================================================
  // DOM: EXTRACT POST TEXT
  // ============================================================
  const POST_SELECTORS = {
    // LinkedIn 2025/2026: posts are role="listitem" divs inside main
    container: [
      'div[role="listitem"]',
    ],
    // Post text lives in expandable-text-box test id elements
    textContent: [
      '[data-testid="expandable-text-box"]',
    ],
    feed: [
      'main',
    ],
  };

  function findBySelectors(parent, selectors) {
    for (const sel of selectors) {
      const el = parent.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function findAllPosts() {
    // Only look inside main feed, not sidebar
    const feed = document.querySelector('main');
    if (!feed) return [];
    for (const sel of POST_SELECTORS.container) {
      const posts = feed.querySelectorAll(sel);
      if (posts.length > 0) return Array.from(posts);
    }
    return [];
  }

  function isPromotedPost(postElement) {
    const text = postElement.innerText || '';
    // LinkedIn marks promoted posts with "Promoted" near the top of the element
    // Check the first ~300 chars where the author/meta info lives
    const header = text.substring(0, 300);
    return /\bPromoted\b/.test(header);
  }

  function extractPostText(postElement) {
    // Use the expandable-text-box which contains just the post body
    for (const sel of POST_SELECTORS.textContent) {
      const textEl = postElement.querySelector(sel);
      if (textEl) {
        const text = textEl.innerText || textEl.textContent || '';
        const cleaned = text.trim().replace(/\s+/g, ' ');
        if (cleaned.length > 0) return cleaned;
      }
    }
    // Fallback: no expandable-text-box found (image-only, video, etc)
    return null;
  }

  // ============================================================
  // STYLES
  // ============================================================
  function injectStyles() {
    const css = document.createElement('style');
    css.textContent = `
      /* ---- Score badges ---- */
      .sf-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        color: white;
        padding: 3px 10px;
        border-radius: 14px;
        font-size: 11px;
        font-weight: 700;
        z-index: 100;
        cursor: help;
        letter-spacing: 0.3px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        box-shadow: 0 1px 4px rgba(0,0,0,0.2);
        transition: transform 0.15s ease;
      }
      .sf-badge:hover { transform: scale(1.1); }
      .sf-badge-high { background: #0a7c42; }
      .sf-badge-mid  { background: #6b7280; }
      .sf-badge-low  { background: #b91c1c; }
      .sf-badge-pending {
        background: #d97706;
        animation: sf-pulse 1.5s ease-in-out infinite;
      }
      @keyframes sf-pulse {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 1; }
      }

      /* ---- Tooltip ---- */
      .sf-tooltip {
        display: none;
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 6px;
        background: #1a1a2e;
        color: #e0e0e0;
        border: 1px solid #444;
        border-radius: 8px;
        padding: 10px 14px;
        font-size: 11px;
        font-weight: 400;
        white-space: nowrap;
        z-index: 200;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        line-height: 1.7;
      }
      .sf-badge:hover .sf-tooltip { display: block; }
      .sf-tooltip .sf-dim-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
      }
      .sf-tooltip .sf-dim-bar {
        display: inline-block;
        height: 6px;
        border-radius: 3px;
        vertical-align: middle;
        margin-left: 6px;
      }
      .sf-tooltip .sf-reason {
        border-top: 1px solid #333;
        margin-top: 6px;
        padding-top: 6px;
        font-style: italic;
        white-space: normal;
        max-width: 260px;
        color: #aaa;
      }

      /* ---- Review mode: dim low-scoring posts ---- */
      .sf-review-dimmed {
        opacity: 0.35 !important;
        border-left: 4px solid #b91c1c !important;
        transition: opacity 0.3s ease;
      }
      .sf-review-dimmed:hover { opacity: 0.9 !important; }

      /* ---- Filter mode: hide low-scoring posts ---- */
      .sf-hidden {
        display: none !important;
      }

      /* ---- Panel ---- */
      #sf-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: #1a1a2e;
        color: #e0e0e0;
        border-radius: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        line-height: 1.5;
        z-index: 10000;
        box-shadow: 0 4px 24px rgba(0,0,0,0.35);
        min-width: 240px;
        max-width: 380px;
        cursor: default;
        user-select: none;
        border: 1px solid #333;
        overflow: hidden;
      }
      #sf-panel-header {
        padding: 12px 16px 8px;
      }
      #sf-panel-header .sf-title {
        font-weight: 700;
        font-size: 13px;
        color: #fff;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .sf-btn {
        cursor: pointer;
        opacity: 0.7;
        font-size: 13px;
        transition: opacity 0.15s;
        background: none;
        border: none;
        color: #e0e0e0;
        padding: 0;
      }
      .sf-btn:hover { opacity: 1; }

      #sf-stats-area {
        padding: 0 16px 10px;
        font-size: 11.5px;
      }
      .sf-stat-row {
        display: flex;
        justify-content: space-between;
        padding: 1px 0;
      }

      /* Mode toggle */
      .sf-toggle {
        display: flex;
        margin: 0 16px 10px;
        background: #111;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #333;
      }
      .sf-toggle button {
        flex: 1;
        padding: 4px 0;
        border: none;
        background: transparent;
        color: #888;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
      }
      .sf-toggle button.active {
        background: #2563eb;
        color: #fff;
      }

      /* Drawer */
      #sf-drawer {
        max-height: 0;
        overflow-y: auto;
        transition: max-height 0.3s ease;
      }
      #sf-drawer.open { max-height: 320px; }

      #sf-drawer-toggle {
        display: block;
        width: 100%;
        padding: 6px 16px;
        border: none;
        border-top: 1px solid #333;
        background: #15152a;
        color: #888;
        font-size: 11px;
        cursor: pointer;
        text-align: left;
        font-family: inherit;
        transition: color 0.15s;
      }
      #sf-drawer-toggle:hover { color: #ccc; }

      .sf-drawer-item {
        padding: 8px 16px;
        border-bottom: 1px solid #222;
        font-size: 11px;
        line-height: 1.5;
      }
      .sf-drawer-item:last-child { border-bottom: none; }
      .sf-di-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 3px;
      }
      .sf-di-score { font-weight: 700; color: #f87171; }
      .sf-di-dims { color: #666; font-size: 10px; font-family: monospace; }
      .sf-di-time { color: #555; font-size: 10px; }
      .sf-di-reason { color: #999; font-style: italic; }
      .sf-di-preview {
        color: #666;
        margin-top: 3px;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .sf-drawer-empty {
        padding: 16px;
        text-align: center;
        color: #555;
        font-style: italic;
      }

      #sf-status-bar {
        padding: 4px 16px 8px;
        font-size: 10.5px;
        color: #555;
      }
    `;
    document.head.appendChild(css);
  }

  // ============================================================
  // SCORE BADGE
  // ============================================================
  function createBadge(score) {
    const overall = score.overall || 0;
    const tier = overall >= 7 ? 'high' : overall >= CONFIG.QUALITY_THRESHOLD ? 'mid' : 'low';

    const badge = document.createElement('div');
    badge.className = `sf-badge sf-badge-${tier}`;

    function dimBar(val) {
      const w = Math.round((val / 5) * 40);
      const color = val >= 4 ? '#4ade80' : val >= 3 ? '#facc15' : '#f87171';
      return `<span class="sf-dim-bar" style="width:${w}px;background:${color};"></span>`;
    }

    badge.innerHTML = `
      ${overall}/10
      <div class="sf-tooltip">
        <div class="sf-dim-row"><span>Specificity</span><span>${score.specificity}/5 ${dimBar(score.specificity)}</span></div>
        <div class="sf-dim-row"><span>Reasoning</span><span>${score.original_reasoning}/5 ${dimBar(score.original_reasoning)}</span></div>
        <div class="sf-dim-row"><span>Grounding</span><span>${score.experiential_grounding}/5 ${dimBar(score.experiential_grounding)}</span></div>
        <div class="sf-dim-row"><span>Honesty</span><span>${score.epistemic_honesty}/5 ${dimBar(score.epistemic_honesty)}</span></div>
        <div class="sf-reason">${score.reason || ''}</div>
      </div>
    `;
    return badge;
  }

  // ============================================================
  // API
  // ============================================================
  function callOpenAI(posts) {
    return new Promise((resolve, reject) => {
      const userContent = posts
        .map((p, i) => `--- POST post_${i} ---\n${p.text.substring(0, CONFIG.MAX_TEXT_LENGTH)}`)
        .join('\n\n');

      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${state.apiKey}`,
        },
        data: JSON.stringify({
          model: CONFIG.MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
        }),
        onload: (response) => {
          try {
            const data = JSON.parse(response.responseText);
            if (data.error) {
              reject(new Error(data.error.message || 'OpenAI API error'));
              return;
            }
            const content = data.choices?.[0]?.message?.content;
            if (!content) {
              reject(new Error('Empty response'));
              return;
            }
            log('Raw API response:', content.substring(0, 500));
            let scores;
            try {
              const parsed = JSON.parse(content);
              // json_object mode always returns an object, find the array inside
              if (Array.isArray(parsed)) {
                scores = parsed;
              } else {
                // Try common wrapper keys
                const arrayVal = Object.values(parsed).find(v => Array.isArray(v));
                if (arrayVal) {
                  scores = arrayVal;
                } else {
                  // Single object returned, wrap it
                  scores = [parsed];
                }
              }
              log(`Parsed ${scores.length} scores from response`);
            } catch {
              const match = content.match(/\[[\s\S]*\]/);
              if (match) {
                scores = JSON.parse(match[0]);
              } else {
                reject(new Error('Could not parse scores'));
                return;
              }
            }
            resolve(scores);
          } catch (err) {
            reject(err);
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
        timeout: 30000,
      });
    });
  }

  // ============================================================
  // APPLY SCORE
  // ============================================================
  function applyScore(postElement, score, postText) {
    const overall = score.overall || 0;

    postElement.setAttribute('data-signal-score', overall);
    postElement.setAttribute('data-signal-reason', score.reason || '');

    // Position for badge
    const pos = window.getComputedStyle(postElement).position;
    if (pos === 'static') postElement.style.position = 'relative';

    // Remove pending badge
    const pendingBadge = postElement.querySelector('[data-sf-pending]');
    if (pendingBadge) pendingBadge.remove();

    // Badge on every scored post
    postElement.appendChild(createBadge(score));

    const isBelowThreshold = overall < CONFIG.QUALITY_THRESHOLD;

    if (isBelowThreshold) {
      if (state.reviewMode) {
        postElement.classList.add('sf-review-dimmed');
      } else {
        postElement.classList.add('sf-hidden');
      }

      state.filteredLog.unshift({
        text: postText.substring(0, 200),
        score: overall,
        reason: score.reason || '',
        dimensions: {
          specificity: score.specificity,
          reasoning: score.original_reasoning,
          grounding: score.experiential_grounding,
          honesty: score.epistemic_honesty,
        },
        timestamp: new Date(),
        element: postElement,
      });
      if (state.filteredLog.length > 50) state.filteredLog.pop();

      state.stats.hidden++;
      log(`FILTERED (${overall}/10): ${score.reason}`);
    } else {
      state.stats.shown++;
      log(`KEPT (${overall}/10): ${score.reason}`);
    }

    state.stats.scanned++;
    updatePanel();
  }

  // ============================================================
  // MODE SWITCHING
  // ============================================================
  function setMode(mode) {
    state.reviewMode = mode === 'review';

    document.querySelectorAll('[data-signal-score]').forEach((el) => {
      const score = parseInt(el.getAttribute('data-signal-score'), 10);
      if (score < CONFIG.QUALITY_THRESHOLD) {
        if (state.reviewMode) {
          el.classList.remove('sf-hidden');
          el.classList.add('sf-review-dimmed');
        } else {
          el.classList.remove('sf-review-dimmed');
          el.classList.add('sf-hidden');
        }
      }
    });

    updatePanel();
  }

  // ============================================================
  // BATCH PROCESSING
  // ============================================================
  async function processBatch() {
    if (state.processing || state.queue.length === 0 || state.paused) return;

    state.processing = true;
    updatePanel();
    const batch = state.queue.splice(0, CONFIG.BATCH_SIZE);

    log(`Processing batch of ${batch.length}...`);

    try {
      const scores = await callOpenAI(batch);
      log(`Received ${scores.length} scores for ${batch.length} posts`);

      // Apply scores to matching posts
      scores.forEach((score, i) => {
        if (batch[i]?.element) {
          applyScore(batch[i].element, score, batch[i].text);
        }
      });

      // Handle any posts that didn't get a score back
      if (scores.length < batch.length) {
        log(`${batch.length - scores.length} posts missed by API — re-queuing`);
        for (let i = scores.length; i < batch.length; i++) {
          if (batch[i]?.element) {
            // Remove pending badge before re-queuing
            const pending = batch[i].element.querySelector('[data-sf-pending]');
            if (pending) pending.remove();
            // Remove from processedPosts so it can be re-queued
            state.processedPosts.delete(batch[i].element);
            queuePost(batch[i].element);
          }
        }
      }
    } catch (err) {
      log('Error:', err.message);
      state.stats.errors++;
      updatePanel();

      // On error, clear pending badges from the failed batch
      batch.forEach(item => {
        if (item?.element) {
          const pending = item.element.querySelector('[data-sf-pending]');
          if (pending) {
            pending.textContent = '⚠';
            pending.classList.remove('sf-badge-pending');
            pending.classList.add('sf-badge-low');
            pending.title = `Scoring failed: ${err.message}`;
          }
        }
      });

      if (err.message.includes('401') || err.message.includes('Incorrect API key')) {
        state.apiKey = null;
        await GM_setValue('openai_api_key', null);
        alert('Signal Filter: Invalid API key. Update via Tampermonkey menu.');
      }
    }

    state.processing = false;
    updatePanel();

    if (state.queue.length > 0) {
      setTimeout(processBatch, CONFIG.API_COOLDOWN_MS);
    }
  }

  // Auto-filter a post without an API call (promoted, no text, etc.)
  function autoFilter(postElement, reason) {
    // Position for badge
    const pos = window.getComputedStyle(postElement).position;
    if (pos === 'static') postElement.style.position = 'relative';

    // Give it a score of 0 and a badge
    postElement.setAttribute('data-signal-score', '0');
    postElement.setAttribute('data-signal-reason', reason);

    const badge = document.createElement('div');
    badge.className = 'sf-badge sf-badge-low';
    badge.innerHTML = `
      auto
      <div class="sf-tooltip">
        <div class="sf-reason">${reason}</div>
      </div>
    `;
    postElement.appendChild(badge);

    if (state.reviewMode) {
      postElement.classList.add('sf-review-dimmed');
    } else {
      postElement.classList.add('sf-hidden');
    }

    // Log to drawer
    const preview = (postElement.innerText || '').substring(0, 200).replace(/\n/g, ' | ');
    state.filteredLog.unshift({
      text: preview,
      score: 0,
      reason: reason,
      dimensions: { specificity: 0, reasoning: 0, grounding: 0, honesty: 0 },
      timestamp: new Date(),
      element: postElement,
    });
    if (state.filteredLog.length > 50) state.filteredLog.pop();

    state.stats.hidden++;
    state.stats.scanned++;
    log(`AUTO-FILTERED: ${reason}`);
    updatePanel();
  }

  function queuePost(postElement) {
    if (state.processedPosts.has(postElement)) return;
    state.processedPosts.add(postElement);

    // Auto-filter promoted/sponsored posts
    if (isPromotedPost(postElement)) {
      autoFilter(postElement, 'Promoted/sponsored content');
      return;
    }

    const text = extractPostText(postElement);
    if (!text || text.length < CONFIG.MIN_TEXT_LENGTH) {
      autoFilter(postElement, 'No evaluable text content');
      return;
    }

    log(`Queued post (${text.length} chars): ${text.substring(0, 80)}...`);

    // Add pending badge so user can see it's been detected
    const pos = window.getComputedStyle(postElement).position;
    if (pos === 'static') postElement.style.position = 'relative';
    const pending = document.createElement('div');
    pending.className = 'sf-badge sf-badge-pending';
    pending.setAttribute('data-sf-pending', 'true');
    pending.textContent = '...';
    postElement.appendChild(pending);

    state.queue.push({ element: postElement, text });
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(processBatch, CONFIG.DEBOUNCE_MS);
  }

  // ============================================================
  // DOM OBSERVATION
  // ============================================================
  function scanExistingPosts() {
    const posts = findAllPosts();
    log(`Initial scan: ${posts.length} posts`);
    posts.forEach(queuePost);
  }

  function startObserver() {
    const feedEl = findBySelectors(document, POST_SELECTORS.feed) || document.body;
    const observer = new MutationObserver((mutations) => {
      if (state.paused) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          for (const sel of POST_SELECTORS.container) {
            if (node.matches?.(sel)) queuePost(node);
            const posts = node.querySelectorAll?.(sel);
            if (posts) posts.forEach(queuePost);
          }
        }
      }
    });
    observer.observe(feedEl, { childList: true, subtree: true });
    log('Observer started');
  }

  // Periodic rescan — catches posts the MutationObserver misses
  // (LinkedIn sometimes updates DOM in ways that don't trigger childList mutations)
  function startRescanLoop() {
    setInterval(() => {
      if (state.paused) return;
      const posts = findAllPosts();
      let newCount = 0;
      posts.forEach(p => {
        if (!state.processedPosts.has(p)) {
          queuePost(p);
          newCount++;
        }
      });
      if (newCount > 0) log(`Rescan found ${newCount} new posts`);
    }, 5000);
    log('Rescan loop started (every 5s)');
  }

  // ============================================================
  // PANEL
  // ============================================================
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = 'sf-panel';
    panel.innerHTML = `
      <div id="sf-panel-header">
        <div class="sf-title">
          <span>⚡ Signal Filter</span>
          <button class="sf-btn" id="sf-pause-btn" title="Pause/Resume">⏸</button>
        </div>
      </div>
      <div class="sf-toggle">
        <button id="sf-mode-filter" class="active">Filter</button>
        <button id="sf-mode-review">Review</button>
      </div>
      <div id="sf-stats-area"></div>
      <div id="sf-status-bar"></div>
      <button id="sf-drawer-toggle">▸ Filtered posts (0)</button>
      <div id="sf-drawer"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById('sf-pause-btn').addEventListener('click', () => {
      state.paused = !state.paused;
      updatePanel();
    });
    document.getElementById('sf-mode-filter').addEventListener('click', () => setMode('filter'));
    document.getElementById('sf-mode-review').addEventListener('click', () => setMode('review'));
    document.getElementById('sf-drawer-toggle').addEventListener('click', () => {
      state.drawerOpen = !state.drawerOpen;
      updatePanel();
    });

    updatePanel();
  }

  function updatePanel() {
    const statsEl = document.getElementById('sf-stats-area');
    const statusEl = document.getElementById('sf-status-bar');
    const pauseBtn = document.getElementById('sf-pause-btn');
    const drawerEl = document.getElementById('sf-drawer');
    const drawerToggle = document.getElementById('sf-drawer-toggle');
    const filterBtn = document.getElementById('sf-mode-filter');
    const reviewBtn = document.getElementById('sf-mode-review');

    if (!statsEl) return;

    const { scanned, hidden, shown, skipped, errors } = state.stats;
    const hideRate = scanned > 0 ? Math.round((hidden / scanned) * 100) : 0;

    statsEl.innerHTML = `
      <div class="sf-stat-row">
        <span style="color:#4ade80;">✓ ${shown} kept</span>
        <span style="color:#f87171;">✗ ${hidden} filtered</span>
      </div>
      <div class="sf-stat-row">
        <span style="color:#aaa;">${scanned} scanned</span>
        <span style="color:#aaa;">Noise: ${hideRate}%</span>
      </div>
      <div class="sf-stat-row" style="color:#666;margin-top:2px;">
        <span>Threshold: ${CONFIG.QUALITY_THRESHOLD}/10</span>
        <span>${CONFIG.MODEL}</span>
      </div>
      ${errors > 0 ? `<div style="color:#fbbf24;margin-top:2px;">⚠ ${errors} errors</div>` : ''}
    `;

    statusEl.textContent = state.paused
      ? '⏸ Paused'
      : state.processing
        ? '⏳ Evaluating batch...'
        : state.queue.length > 0
          ? `📋 ${state.queue.length} queued`
          : '👀 Watching';

    if (pauseBtn) pauseBtn.textContent = state.paused ? '▶' : '⏸';

    if (filterBtn && reviewBtn) {
      filterBtn.classList.toggle('active', !state.reviewMode);
      reviewBtn.classList.toggle('active', state.reviewMode);
    }

    if (drawerToggle) {
      const arrow = state.drawerOpen ? '▾' : '▸';
      drawerToggle.textContent = `${arrow} Filtered posts (${state.filteredLog.length})`;
    }

    if (drawerEl) {
      drawerEl.classList.toggle('open', state.drawerOpen);

      if (state.drawerOpen) {
        if (state.filteredLog.length === 0) {
          drawerEl.innerHTML = '<div class="sf-drawer-empty">No posts filtered yet</div>';
        } else {
          drawerEl.innerHTML = state.filteredLog
            .map((item) => {
              const time = item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const d = item.dimensions;
              return `
                <div class="sf-drawer-item">
                  <div class="sf-di-header">
                    <span class="sf-di-score">${item.score}/10</span>
                    <span class="sf-di-dims">S:${d.specificity} R:${d.reasoning} G:${d.grounding} H:${d.honesty}</span>
                    <span class="sf-di-time">${time}</span>
                  </div>
                  <div class="sf-di-reason">${item.reason}</div>
                  <div class="sf-di-preview">${item.text}</div>
                </div>
              `;
            })
            .join('');
        }
      }
    }
  }

  // ============================================================
  // INIT
  // ============================================================
  async function init() {
    log('Signal Filter v0.2.0 initialising...');

    state.apiKey = await getApiKey();
    if (!state.apiKey) {
      log('No API key — disabled');
      return;
    }

    injectStyles();
    createPanel();

    setTimeout(() => {
      scanExistingPosts();
      startObserver();
      startRescanLoop();
      log('Active');
    }, 2000);
  }

  init();
})();
