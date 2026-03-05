// ==UserScript==
// @name         AI Studio Exporter
// @namespace    aistudio-tools
// @version      1.4.7
// @description  Export conversations from Google AI Studio with chain-of-thought, citations, dates, draggable UI, and quick action buttons
// @match        https://aistudio.google.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  // ============================================================
  // API Layer
  // ============================================================
  const API = {
    _baseUrl: null,
    _apiKey: null,

    getBaseUrl() {
      if (this._baseUrl) return this._baseUrl;
      
      // Extract base URL from network requests or scripts
      const perf = performance.getEntriesByType('resource');
      for (const r of perf) {
        const match = r.name.match(/(https:\/\/[^/]+alkali[^/]+)\//);
        if (match && r.name.includes('MakerSuiteService')) {
          this._baseUrl = match[1] + '/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService';
          return this._baseUrl;
        }
      }
      
      // Fallback to known endpoint
      this._baseUrl = 'https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService';
      return this._baseUrl;
    },

    getApiKey() {
      if (this._apiKey) return this._apiKey;
      
      // Look for the MakerSuite API key by its config identifier "WIu0Nc"
      // This is the key associated with "default_MakerSuite"
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        
        // Primary pattern: look for WIu0Nc config key
        const configMatch = text.match(/"WIu0Nc"\s*:\s*"(AIzaSy[\w-]+)"/);
        if (configMatch) {
          this._apiKey = configMatch[1];
          return this._apiKey;
        }
      }
      
      // Fallback: find key near "default_MakerSuite" context
      for (const script of scripts) {
        const text = script.textContent || '';
        const makerSuiteIdx = text.indexOf('default_MakerSuite');
        if (makerSuiteIdx !== -1) {
          // Search nearby for an API key
          const nearby = text.substring(Math.max(0, makerSuiteIdx - 200), makerSuiteIdx + 200);
          const keyMatch = nearby.match(/AIzaSy[\w-]{30,40}/);
          if (keyMatch) {
            this._apiKey = keyMatch[0];
            return this._apiKey;
          }
        }
      }
      
      // Last fallback: just find any API key on the page
      for (const script of scripts) {
        const match = script.textContent?.match(/AIzaSy[\w-]{30,40}/);
        if (match) {
          this._apiKey = match[0];
          return this._apiKey;
        }
      }
      
      console.warn('AI Studio Exporter: Could not find API key in page');
      return null;
    },

    async generateAuth() {
      const origin = 'https://aistudio.google.com';
      const timestamp = Math.floor(Date.now() / 1000);

      const cookies = document.cookie.split(';').reduce((acc, c) => {
        const [key, ...val] = c.trim().split('=');
        acc[key] = val.join('=');
        return acc;
      }, {});

      async function sha1(str) {
        const data = new TextEncoder().encode(str);
        const hash = await crypto.subtle.digest('SHA-1', data);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      }

      const variants = [
        ['SAPISIDHASH', cookies['SAPISID']],
        ['SAPISID1PHASH', cookies['__Secure-1PAPISID']],
        ['SAPISID3PHASH', cookies['__Secure-3PAPISID']]
      ];

      const hashes = [];
      for (const [prefix, sapisid] of variants) {
        if (sapisid) {
          const hash = await sha1(`${timestamp} ${sapisid} ${origin}`);
          hashes.push(`${prefix} ${timestamp}_${hash}`);
        }
      }

      return hashes.join(' ');
    },

    async call(method, body) {
      const auth = await this.generateAuth();
      const apiKey = this.getApiKey();
      const baseUrl = this.getBaseUrl();

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${baseUrl}/${method}`, true);
        xhr.setRequestHeader('Content-Type', 'application/json+protobuf');
        if (apiKey) {
          xhr.setRequestHeader('X-Goog-Api-Key', apiKey);
        }
        xhr.setRequestHeader('Authorization', auth);
        xhr.setRequestHeader('X-Goog-AuthUser', '0');
        xhr.withCredentials = true;

        xhr.onload = () => {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (e) {
            reject(new Error(`Parse error: ${xhr.responseText.substring(0, 200)}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(JSON.stringify(body));
      });
    },

    async listPrompts(pageToken = null) {
      const body = pageToken ? [100, pageToken] : [100];
      return this.call('ListPrompts', body);
    },

    async getAllPrompts(onProgress = null) {
      const allPrompts = [];
      let pageToken = null;
      let page = 0;

      do {
        const response = await this.listPrompts(pageToken);
        
        if (typeof response[0] === 'number') {
          throw new Error(`API Error: ${response[1]}`);
        }
        
        if (response[0]?.length) {
          allPrompts.push(...response[0]);
          page++;
          if (onProgress) onProgress(allPrompts.length, page);
        }
        
        pageToken = response[1] || null;
      } while (pageToken);

      return allPrompts;
    },

    async getConversation(promptId) {
      const cleanId = promptId.replace('prompts/', '');
      return this.call('ResolveDriveResource', [cleanId]);
    }
  };

  // ============================================================
  // Parser - Based on discovered schema
  // ============================================================
  const Parser = {
    parsePromptList(prompts) {
      return prompts.map(p => ({
        id: p[0],
        title: p[4]?.[0] || 'Untitled',
        author: p[4]?.[2]?.[0] || 'Unknown',
        model: p[3]?.[2] || 'unknown',
        updatedAt: this.parseTimestamp(p[4]?.[4]?.[0]?.[0])
      }));
    },

    parseTimestamp(ts) {
      if (!ts) return null;
      const seconds = parseInt(ts);
      return isNaN(seconds) ? null : new Date(seconds * 1000);
    },

    parseConversation(data) {
      const prompt = data[0];
      const config = prompt[3];
      const metadata = prompt[4];
      const rawMessages = prompt[13] || [];
      
      return {
        id: prompt[0],
        title: metadata?.[0] || 'Untitled',
        model: config?.[2] || 'unknown',
        temperature: config?.[4] || 0,
        maxTokens: config?.[6] || 0,
        author: metadata?.[2]?.[0] || 'Unknown',
        authorAvatar: metadata?.[2]?.[2] || null,
        updatedAt: this.parseTimestamp(metadata?.[4]?.[0]?.[0]),
        messages: this.parseMessages(rawMessages)
      };
    },

    parseMessages(turns) {
      const messages = [];
      
      for (const turn of turns) {
        for (const msg of turn) {
          const content = msg[0] || '';
          const role = msg[8] || 'unknown';
          const tokenCount = msg[18] || 0;
          const hasCitations = msg[16] === 1;
          const citationData = msg[15];
          
          const isThinking = role === 'model' && /^\*\*[^*]+\*\*/.test(content);
          
          const citations = [];
          const searchQueries = [];
          if (citationData && Array.isArray(citationData)) {
            if (Array.isArray(citationData[0])) {
              for (const cite of citationData[0]) {
                if (cite[1] && typeof cite[1] === 'string') {
                  citations.push({
                    offset: cite[0],
                    url: cite[1],
                    index: cite[2]
                  });
                }
              }
            }
            if (Array.isArray(citationData[1])) {
              searchQueries.push(...citationData[1].filter(q => typeof q === 'string'));
            }
          }
          
          messages.push({
            role,
            content,
            tokenCount,
            isThinking,
            hasCitations,
            citations,
            searchQueries
          });
        }
      }
      
      return messages;
    }
  };

  // ============================================================
  // Exporters
  // ============================================================
  const Exporters = {
    formatDate(date) {
      if (!date) return 'Unknown';
      return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    },

    formatDateShort(date) {
      if (!date) return '';
      return date.toISOString().slice(0, 10); // YYYY-MM-DD
    },

    toMarkdown(conv, options = {}) {
      const { includeThinking = true, includeCitations = true, includeTokens = false } = options;
      
      let md = `# ${conv.title}\n\n`;
      md += `**Model:** ${conv.model}  \n`;
      md += `**Author:** ${conv.author}  \n`;
      md += `**Last Updated:** ${this.formatDate(conv.updatedAt)}  \n`;
      md += `\n---\n\n`;

      for (const msg of conv.messages) {
        if (msg.isThinking && !includeThinking) continue;
        
        const roleEmoji = msg.role === 'user' ? '👤' : (msg.isThinking ? '💭' : '🤖');
        const roleLabel = msg.role === 'user' ? 'User' : (msg.isThinking ? 'Thinking' : 'Assistant');
        
        md += `## ${roleEmoji} ${roleLabel}`;
        if (includeTokens && msg.tokenCount) {
          md += ` *(${msg.tokenCount} tokens)*`;
        }
        md += `\n\n`;
        
        md += `${msg.content}\n\n`;

        if (includeCitations && msg.citations.length > 0) {
          md += `**Sources:**\n`;
          const uniqueUrls = [...new Set(msg.citations.map(c => c.url))];
          uniqueUrls.forEach((url, i) => {
            const decoded = this.decodeGoogleUrl(url);
            md += `${i + 1}. ${decoded}\n`;
          });
          md += '\n';
        }

        if (includeCitations && msg.searchQueries.length > 0) {
          md += `*Search queries: ${msg.searchQueries.join(', ')}*\n\n`;
        }

        md += `---\n\n`;
      }

      return md;
    },

    decodeGoogleUrl(url) {
      try {
        const parsed = new URL(url);
        const q = parsed.searchParams.get('q');
        return q ? decodeURIComponent(q) : url;
      } catch {
        return url;
      }
    },

    toJSON(conv) {
      return JSON.stringify(conv, null, 2);
    },

    toHTML(conv, options = {}) {
      const { includeThinking = true } = options;
      
      const escapeHtml = (str) => str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(conv.title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; background: #0f0f0f; color: #e0e0e0; line-height: 1.6; }
    .message { margin: 20px 0; padding: 20px; border-radius: 12px; }
    .user { background: #1a2e1a; border-left: 4px solid #4a9; }
    .model { background: #1a1a2e; border-left: 4px solid #49a; }
    .thinking { background: #2e2a1a; border-left: 4px solid #a94; opacity: 0.9; }
    .role { font-weight: bold; margin-bottom: 10px; font-size: 0.9em; color: #888; }
    .content { white-space: pre-wrap; }
    .citations { margin-top: 15px; padding-top: 15px; border-top: 1px solid #333; font-size: 0.85em; }
    .citations a { color: #6af; }
    .tokens { color: #666; font-size: 0.8em; }
    pre { background: #000; padding: 15px; overflow-x: auto; border-radius: 8px; }
    code { font-family: 'Fira Code', 'Consolas', monospace; }
    h1 { color: #4a9eff; border-bottom: 1px solid #333; padding-bottom: 10px; }
    .meta { color: #666; font-size: 0.9em; margin-bottom: 30px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(conv.title)}</h1>
  <p class="meta">
    Model: ${escapeHtml(conv.model)} | 
    Author: ${escapeHtml(conv.author)} | 
    Updated: ${this.formatDate(conv.updatedAt)}
  </p>
`;

      for (const msg of conv.messages) {
        if (msg.isThinking && !includeThinking) continue;
        
        const roleClass = msg.role === 'user' ? 'user' : (msg.isThinking ? 'thinking' : 'model');
        const roleLabel = msg.role === 'user' ? '👤 User' : (msg.isThinking ? '💭 Thinking' : '🤖 Assistant');
        
        html += `  <div class="message ${roleClass}">
    <div class="role">${roleLabel} <span class="tokens">(${msg.tokenCount} tokens)</span></div>
    <div class="content">${escapeHtml(msg.content)}</div>`;

        if (msg.citations.length > 0) {
          html += `\n    <div class="citations"><strong>Sources:</strong><br>`;
          const uniqueUrls = [...new Set(msg.citations.map(c => c.url))];
          uniqueUrls.forEach((url, i) => {
            const decoded = Exporters.decodeGoogleUrl(url);
            html += `      ${i + 1}. <a href="${escapeHtml(decoded)}" target="_blank">${escapeHtml(decoded.substring(0, 80))}...</a><br>\n`;
          });
          html += `    </div>`;
        }

        html += `\n  </div>\n`;
      }

      html += `</body></html>`;
      return html;
    },

    getStats(conv) {
      const stats = {
        totalTokens: 0,
        userTokens: 0,
        modelTokens: 0,
        thinkingTokens: 0,
        messageCount: conv.messages.length,
        userMessages: 0,
        modelMessages: 0,
        thinkingMessages: 0,
        citationCount: 0
      };

      for (const msg of conv.messages) {
        stats.totalTokens += msg.tokenCount;
        if (msg.role === 'user') {
          stats.userTokens += msg.tokenCount;
          stats.userMessages++;
        } else if (msg.isThinking) {
          stats.thinkingTokens += msg.tokenCount;
          stats.thinkingMessages++;
        } else {
          stats.modelTokens += msg.tokenCount;
          stats.modelMessages++;
        }
        stats.citationCount += msg.citations.length;
      }

      return stats;
    }
  };

  // ============================================================
  // UI
  // ============================================================
  const UI = {
    // Helper to create element with attributes and children
    el(tag, attrs = {}, children = []) {
      const element = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'style' && typeof value === 'object') {
          Object.assign(element.style, value);
        } else if (key === 'className') {
          element.className = value;
        } else if (key === 'textContent') {
          element.textContent = value;
        } else if (key.startsWith('on') && typeof value === 'function') {
          element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'checked' && value) {
          element.checked = true;
        } else if (key === 'for') {
          element.htmlFor = value;
        } else {
          element.setAttribute(key, value);
        }
      }
      children.forEach(child => {
        if (typeof child === 'string') {
          element.appendChild(document.createTextNode(child));
        } else if (child) {
          element.appendChild(child);
        }
      });
      return element;
    },

    styles: `
      .ais-panel {
        position: fixed;
        top: 60px;
        right: 20px;
        z-index: 10000;
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 12px;
        padding: 16px;
        min-width: 320px;
        max-width: 400px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        font-family: system-ui, sans-serif;
        color: #e0e0e0;
        font-size: 14px;
      }
      .ais-panel h3 {
        margin: 0 0 16px 0;
        color: #4a9eff;
        font-size: 16px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .ais-btn {
        display: block;
        width: 100%;
        padding: 10px 16px;
        margin: 8px 0;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.15s;
        text-align: left;
      }
      .ais-btn.primary {
        background: linear-gradient(135deg, #4285f4, #34a0dc);
        color: white;
      }
      .ais-btn.primary:hover { background: linear-gradient(135deg, #5a9fff, #4ab0ec); }
      .ais-btn.secondary {
        background: #2a2a2a;
        color: #e0e0e0;
        border: 1px solid #444;
      }
      .ais-btn.secondary:hover { background: #333; }
      .ais-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .ais-toggle {
        position: fixed;
        top: 70px;
        right: 20px;
        z-index: 10001;
        background: linear-gradient(135deg, #4285f4, #34a0dc);
        color: white;
        border: none;
        border-radius: 50%;
        width: 48px;
        height: 48px;
        font-size: 20px;
        cursor: grab;
        box-shadow: 0 4px 12px rgba(66,133,244,0.4);
        transition: transform 0.2s, box-shadow 0.2s;
        user-select: none;
        touch-action: none;
      }
      .ais-toggle:hover { transform: scale(1.1); }
      .ais-toggle.dragging {
        cursor: grabbing;
        transform: scale(1.15);
        box-shadow: 0 8px 24px rgba(66,133,244,0.6);
        transition: none;
      }
      .ais-status {
        font-size: 12px;
        color: #888;
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid #333;
      }
      .ais-options {
        background: #222;
        border-radius: 8px;
        padding: 12px;
        margin: 12px 0;
      }
      .ais-option {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 6px 0;
        font-size: 13px;
      }
      .ais-option input[type="checkbox"] { width: 16px; height: 16px; }
      .ais-select {
        width: 100%;
        padding: 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 6px;
        color: #e0e0e0;
        font-size: 13px;
        margin-top: 8px;
      }
      .ais-stats {
        background: #222;
        border-radius: 8px;
        padding: 12px;
        margin: 12px 0;
        font-size: 12px;
      }
      .ais-stats-row {
        display: flex;
        justify-content: space-between;
        margin: 4px 0;
      }
      .ais-stats-label { color: #888; }
      .ais-stats-value { color: #4a9eff; font-weight: 500; }
      .ais-failed-list {
        background: #2a1a1a;
        border: 1px solid #533;
        border-radius: 8px;
        padding: 12px;
        margin-top: 12px;
        max-height: 150px;
        overflow-y: auto;
        font-size: 12px;
      }
      .ais-failed-list h4 {
        margin: 0 0 8px 0;
        color: #f66;
        font-size: 13px;
      }
      .ais-failed-item {
        color: #caa;
        margin: 4px 0;
        padding-left: 12px;
        border-left: 2px solid #533;
      }
    `,

    panel: null,
    toggleBtn: null,

    init() {
      const style = document.createElement('style');
      style.textContent = this.styles;
      document.head.appendChild(style);

      this.toggleBtn = document.createElement('button');
      this.toggleBtn.className = 'ais-toggle';
      this.toggleBtn.textContent = '📥';
      this.toggleBtn.title = 'AI Studio Exporter (drag to move)';
      // Inline styles as fallback for CSP
      Object.assign(this.toggleBtn.style, {
        position: 'fixed',
        top: '70px',
        right: '20px',
        zIndex: '10001',
        background: 'linear-gradient(135deg, #4285f4, #34a0dc)',
        color: 'white',
        border: 'none',
        borderRadius: '50%',
        width: '48px',
        height: '48px',
        fontSize: '20px',
        cursor: 'grab',
        boxShadow: '0 4px 12px rgba(66,133,244,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none'
      });
      document.body.appendChild(this.toggleBtn);

      // Setup dragging
      this.setupDrag();

      // Click handler (only fires if not dragged)
      this.toggleBtn.addEventListener('click', (e) => {
        if (!this.wasDragged) {
          this.toggle();
        }
        this.wasDragged = false;
      });

      this.panel = this.el('div', { className: 'ais-panel', style: { display: 'none' } }, [
        this.el('h3', { textContent: '📥 AI Studio Exporter' }),
        
        this.el('div', { className: 'ais-stats', id: 'ais-stats', style: { display: 'none' } }, [
          this.el('div', { className: 'ais-stats-row' }, [
            this.el('span', { className: 'ais-stats-label', textContent: 'Total Tokens:' }),
            this.el('span', { className: 'ais-stats-value', id: 'ais-stat-total', textContent: '-' })
          ]),
          this.el('div', { className: 'ais-stats-row' }, [
            this.el('span', { className: 'ais-stats-label', textContent: 'Thinking Tokens:' }),
            this.el('span', { className: 'ais-stats-value', id: 'ais-stat-thinking', textContent: '-' })
          ]),
          this.el('div', { className: 'ais-stats-row' }, [
            this.el('span', { className: 'ais-stats-label', textContent: 'Messages:' }),
            this.el('span', { className: 'ais-stats-value', id: 'ais-stat-messages', textContent: '-' })
          ]),
          this.el('div', { className: 'ais-stats-row' }, [
            this.el('span', { className: 'ais-stats-label', textContent: 'Last Updated:' }),
            this.el('span', { className: 'ais-stats-value', id: 'ais-stat-date', textContent: '-' })
          ])
        ]),

        this.el('button', { 
          className: 'ais-btn primary', 
          id: 'ais-export-current', 
          textContent: '📄 Export Current Chat',
          onClick: () => this.exportCurrent()
        }),

        this.el('button', { 
          className: 'ais-btn secondary', 
          id: 'ais-export-all', 
          textContent: '📦 Export All Chats (ZIP)',
          onClick: () => this.exportAll()
        }),

        this.el('div', { className: 'ais-options' }, [
          this.el('div', { className: 'ais-option' }, [
            this.el('input', { type: 'checkbox', id: 'ais-thinking', checked: 'checked' }),
            this.el('label', { for: 'ais-thinking', textContent: 'Include Chain-of-Thought' })
          ]),
          this.el('div', { className: 'ais-option' }, [
            this.el('input', { type: 'checkbox', id: 'ais-citations', checked: 'checked' }),
            this.el('label', { for: 'ais-citations', textContent: 'Include Citations' })
          ]),
          this.el('div', { className: 'ais-option' }, [
            this.el('input', { type: 'checkbox', id: 'ais-tokens' }),
            this.el('label', { for: 'ais-tokens', textContent: 'Show Token Counts' })
          ]),
          this.el('div', { className: 'ais-option' }, [
            this.el('input', { type: 'checkbox', id: 'ais-dateprefix' }),
            this.el('label', { for: 'ais-dateprefix', textContent: 'Date Prefix in Filenames' })
          ]),
          this.el('select', { className: 'ais-select', id: 'ais-format' }, [
            this.el('option', { value: 'md', textContent: 'Markdown (.md)' }),
            this.el('option', { value: 'json', textContent: 'JSON (.json)' }),
            this.el('option', { value: 'html', textContent: 'HTML (.html)' })
          ])
        ]),

        this.el('div', { className: 'ais-status', id: 'ais-status', textContent: 'Ready' }),
        this.el('div', { id: 'ais-failed-container' })
      ]);
      document.body.appendChild(this.panel);

      this.observeUrl();
    },

    toggle() {
      const visible = this.panel.style.display !== 'none';
      this.panel.style.display = visible ? 'none' : 'block';
      this.toggleBtn.textContent = visible ? '📥' : '✕';
      if (!visible) {
        this.updatePanelPosition();
        this.loadStats();
        this.clearFailedList();
      }
    },

    clearFailedList() {
      const container = document.getElementById('ais-failed-container');
      if (container) {
        while (container.firstChild) {
          container.removeChild(container.firstChild);
        }
      }
    },

    showFailedList(failedChats) {
      if (failedChats.length === 0) return;
      
      const container = document.getElementById('ais-failed-container');
      this.clearFailedList();
      
      const list = this.el('div', { className: 'ais-failed-list' }, [
        this.el('h4', { textContent: `⚠️ Failed to export (${failedChats.length}):` }),
        ...failedChats.map(f => 
          this.el('div', { className: 'ais-failed-item' }, [
            this.el('strong', { textContent: f.title }),
            this.el('br'),
            this.el('small', { textContent: f.error })
          ])
        )
      ]);
      
      container.appendChild(list);
    },

    async loadStats() {
      const match = window.location.pathname.match(/prompts\/([^/]+)/);
      if (!match) {
        document.getElementById('ais-stats').style.display = 'none';
        return;
      }

      try {
        const data = await API.getConversation(match[1]);
        const conv = Parser.parseConversation(data);
        const stats = Exporters.getStats(conv);
        
        document.getElementById('ais-stats').style.display = 'block';
        document.getElementById('ais-stat-total').textContent = stats.totalTokens.toLocaleString();
        document.getElementById('ais-stat-thinking').textContent = stats.thinkingTokens.toLocaleString();
        document.getElementById('ais-stat-messages').textContent = stats.messageCount;
        document.getElementById('ais-stat-date').textContent = Exporters.formatDate(conv.updatedAt);
      } catch (e) {
        console.error('Failed to load stats:', e);
      }
    },

    observeUrl() {
      let lastUrl = location.href;
      new MutationObserver(() => {
        if (location.href !== lastUrl) {
          lastUrl = location.href;
          if (this.panel.style.display !== 'none') {
            this.loadStats();
            this.clearFailedList();
          }
        }
      }).observe(document, { subtree: true, childList: true });
    },

    setupDrag() {
      let isDragging = false;
      let startX, startY, startLeft, startTop;
      this.wasDragged = false;

      // Load saved position
      const savedPos = localStorage.getItem('ais-toggle-position');
      if (savedPos) {
        try {
          const { left, top } = JSON.parse(savedPos);
          this.toggleBtn.style.left = left + 'px';
          this.toggleBtn.style.top = top + 'px';
          this.toggleBtn.style.right = 'auto';
        } catch (e) {}
      }

      const onMouseDown = (e) => {
        if (e.button !== 0) return; // Only left click
        isDragging = true;
        this.wasDragged = false;
        
        const rect = this.toggleBtn.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        
        this.toggleBtn.classList.add('dragging');
        e.preventDefault();
      };

      const onMouseMove = (e) => {
        if (!isDragging) return;
        
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        // Only count as drag if moved more than 5px
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          this.wasDragged = true;
        }
        
        let newLeft = startLeft + dx;
        let newTop = startTop + dy;
        
        // Keep within viewport
        const btnSize = 48;
        newLeft = Math.max(0, Math.min(window.innerWidth - btnSize, newLeft));
        newTop = Math.max(0, Math.min(window.innerHeight - btnSize, newTop));
        
        this.toggleBtn.style.left = newLeft + 'px';
        this.toggleBtn.style.top = newTop + 'px';
        this.toggleBtn.style.right = 'auto';
      };

      const onMouseUp = () => {
        if (!isDragging) return;
        isDragging = false;
        this.toggleBtn.classList.remove('dragging');
        
        // Save position
        if (this.wasDragged) {
          const rect = this.toggleBtn.getBoundingClientRect();
          localStorage.setItem('ais-toggle-position', JSON.stringify({
            left: rect.left,
            top: rect.top
          }));
          
          // Update panel position to follow button
          this.updatePanelPosition();
        }
      };

      this.toggleBtn.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);

      // Touch support
      this.toggleBtn.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        onMouseDown({ clientX: touch.clientX, clientY: touch.clientY, button: 0, preventDefault: () => e.preventDefault() });
      }, { passive: false });

      document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        const touch = e.touches[0];
        onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
      }, { passive: true });

      document.addEventListener('touchend', onMouseUp);
    },

    updatePanelPosition() {
      const btnRect = this.toggleBtn.getBoundingClientRect();
      const panelWidth = 320;
      
      // Position panel relative to button
      if (btnRect.left > window.innerWidth / 2) {
        // Button on right side - panel to left of button
        this.panel.style.right = (window.innerWidth - btnRect.left + 10) + 'px';
        this.panel.style.left = 'auto';
      } else {
        // Button on left side - panel to right of button
        this.panel.style.left = (btnRect.right + 10) + 'px';
        this.panel.style.right = 'auto';
      }
      
      // Vertical position - align with button top
      this.panel.style.top = Math.max(10, btnRect.top) + 'px';
    },

    setStatus(text) {
      document.getElementById('ais-status').textContent = text;
    },

    getOptions() {
      return {
        includeThinking: document.getElementById('ais-thinking').checked,
        includeCitations: document.getElementById('ais-citations').checked,
        includeTokens: document.getElementById('ais-tokens').checked,
        datePrefix: document.getElementById('ais-dateprefix').checked,
        format: document.getElementById('ais-format').value
      };
    },

    buildFilename(conv, ext, options) {
      let name = this.sanitize(conv.title);
      if (options.datePrefix && conv.updatedAt) {
        const dateStr = Exporters.formatDateShort(conv.updatedAt);
        name = `${dateStr}_${name}`;
      }
      return `${name}.${ext}`;
    },

    async exportCurrent() {
      const match = window.location.pathname.match(/prompts\/([^/]+)/);
      if (!match) {
        this.setStatus('❌ Navigate to a conversation first');
        return;
      }

      this.setStatus('⏳ Fetching...');

      try {
        const data = await API.getConversation(match[1]);
        const conv = Parser.parseConversation(data);
        const options = this.getOptions();

        let content, ext;
        switch (options.format) {
          case 'json':
            content = Exporters.toJSON(conv);
            ext = 'json';
            break;
          case 'html':
            content = Exporters.toHTML(conv, options);
            ext = 'html';
            break;
          default:
            content = Exporters.toMarkdown(conv, options);
            ext = 'md';
        }

        const filename = this.buildFilename(conv, ext, options);
        this.download(filename, content);
        this.setStatus(`✅ Exported: ${conv.title}`);
      } catch (e) {
        console.error(e);
        this.setStatus(`❌ ${e.message}`);
      }
    },

    async exportAll() {
      this.setStatus('⏳ Fetching prompt list...');
      this.clearFailedList();

      try {
        const prompts = await API.getAllPrompts((count, page) => {
          this.setStatus(`⏳ Found ${count} chats (page ${page})...`);
        });
        
        this.setStatus(`⏳ Exporting ${prompts.length} chats...`);

        if (!window.JSZip) {
          await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
        }

        const zip = new JSZip();
        const options = this.getOptions();
        let done = 0;
        const failedChats = [];

        for (const prompt of prompts) {
          const promptTitle = prompt[4]?.[0] || 'Untitled';
          const promptId = prompt[0];
          
          try {
            const data = await API.getConversation(promptId);
            const conv = Parser.parseConversation(data);

            let content, ext;
            switch (options.format) {
              case 'json': content = Exporters.toJSON(conv); ext = 'json'; break;
              case 'html': content = Exporters.toHTML(conv, options); ext = 'html'; break;
              default: content = Exporters.toMarkdown(conv, options); ext = 'md';
            }

            const filename = this.buildFilename(conv, ext, options);
            zip.file(filename, content);
            done++;
            this.setStatus(`⏳ ${done}/${prompts.length} exported`);
            
            await new Promise(r => setTimeout(r, 50));
          } catch (e) {
            failedChats.push({
              id: promptId,
              title: promptTitle,
              error: e.message
            });
            console.warn(`Failed to export "${promptTitle}" (${promptId}):`, e.message);
          }
        }

        this.setStatus('⏳ Creating ZIP...');
        const blob = await zip.generateAsync({ type: 'blob' });
        this.downloadBlob(`ai-studio-${new Date().toISOString().slice(0,10)}.zip`, blob);
        
        const failedMsg = failedChats.length ? ` (${failedChats.length} failed)` : '';
        this.setStatus(`✅ Exported ${done} conversations${failedMsg}`);
        
        // Show failed chats list
        this.showFailedList(failedChats);
        
      } catch (e) {
        console.error(e);
        this.setStatus(`❌ ${e.message}`);
      }
    },

    sanitize(name) {
      return (name || 'untitled')
        .replace(/[<>:"/\\|?*]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 80);
    },

    download(filename, content) {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      this.downloadBlob(filename, blob);
    },

    downloadBlob(filename, blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },

    loadScript(src) {
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
  };

  // ============================================================
  // Message Enhancer - Add quick action buttons to messages
  // ============================================================
  const MessageEnhancer = {
    initialized: false,
    observer: null,

    init() {
      if (this.initialized) return;
      this.initialized = true;

      // Add styles for our custom buttons
      const style = document.createElement('style');
      style.textContent = `
        .ais-delete-btn, .ais-branch-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: none;
          background: transparent;
          color: #9aa0a6;
          cursor: pointer;
          border-radius: 50%;
          transition: all 0.15s;
        }
        .ais-delete-btn:hover {
          background: rgba(234, 67, 53, 0.1);
          color: #ea4335;
        }
        .ais-branch-btn:hover {
          background: rgba(66, 133, 244, 0.1);
          color: #4285f4;
        }
        .ais-delete-btn .material-symbols-outlined,
        .ais-branch-btn .material-symbols-outlined {
          font-size: 20px;
        }
        /* Hidden by our script */
        .ais-hidden-menu-item {
          display: none !important;
        }
      `;
      document.head.appendChild(style);

      // Initial enhancement
      this.enhanceMessages();

      // Watch for new messages
      this.observer = new MutationObserver((mutations) => {
        this.enhanceMessages();
        // Also check for menu opening to hide Delete item
        this.hideDeleteMenuItem();
      });

      this.observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      console.log('📝 Message enhancer initialized');
    },

    hideDeleteMenuItem() {
      // Find menu items in any open overlay
      const menuItems = document.querySelectorAll('.cdk-overlay-container button[mat-menu-item]');
      menuItems.forEach(item => {
        const icon = item.querySelector('.start-icon');
        const text = item.textContent?.trim();
        // Hide Delete item
        if (icon?.textContent?.includes('delete') && text?.includes('Delete')) {
          item.classList.add('ais-hidden-menu-item');
        }
        // Hide Branch item
        if (icon?.textContent?.includes('arrow_split') && text?.includes('Branch')) {
          item.classList.add('ais-hidden-menu-item');
        }
      });
    },

    enhanceMessages() {
      // Find all "Open options" menu buttons (the ⋮ button)
      const menuButtons = document.querySelectorAll('button[aria-label="Open options"]');

      menuButtons.forEach(menuBtn => {
        // Navigate up to find the actions container:
        // button -> div -> ms-chat-turn-options -> div.actions.hover-or-edit
        const msChatTurnOptions = menuBtn.closest('ms-chat-turn-options');
        if (!msChatTurnOptions) return;

        const actionsContainer = msChatTurnOptions.parentElement;
        if (!actionsContainer || !actionsContainer.classList.contains('actions')) return;

        // Skip if already enhanced
        if (actionsContainer.dataset.aisEnhanced) return;
        actionsContainer.dataset.aisEnhanced = 'true';

        // Create branch button
        const branchBtn = document.createElement('button');
        branchBtn.className = 'ais-branch-btn';
        branchBtn.setAttribute('aria-label', 'Branch from here');
        branchBtn.title = 'Branch from here';
        const branchIcon = document.createElement('span');
        branchIcon.className = 'material-symbols-outlined';
        branchIcon.textContent = 'arrow_split';
        branchBtn.appendChild(branchIcon);

        branchBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          menuBtn.click();
          await new Promise(r => setTimeout(r, 150));
          const menuItems = document.querySelectorAll('.cdk-overlay-container button[mat-menu-item]');
          for (const item of menuItems) {
            if (item.textContent?.includes('Branch')) {
              item.click();
              return;
            }
          }
          document.body.click();
        };

        // Create delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'ais-delete-btn';
        deleteBtn.setAttribute('aria-label', 'Delete this turn');
        deleteBtn.title = 'Delete this turn';
        const deleteIcon = document.createElement('span');
        deleteIcon.className = 'material-symbols-outlined';
        deleteIcon.textContent = 'delete';
        deleteBtn.appendChild(deleteIcon);

        deleteBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          menuBtn.click();
          await new Promise(r => setTimeout(r, 150));
          const menuItems = document.querySelectorAll('.cdk-overlay-container button[mat-menu-item]');
          for (const item of menuItems) {
            if (item.textContent?.includes('Delete')) {
              item.click();
              return;
            }
          }
          document.body.click();
          console.warn('Delete option not found in menu');
        };

        // Insert buttons before the ms-chat-turn-options element
        actionsContainer.insertBefore(branchBtn, msChatTurnOptions);
        actionsContainer.insertBefore(deleteBtn, msChatTurnOptions);
      });
    },

    destroy() {
      if (this.observer) {
        this.observer.disconnect();
      }
      // Remove our buttons
      document.querySelectorAll('.ais-delete-btn').forEach(btn => btn.remove());
      // Remove enhanced markers
      document.querySelectorAll('[data-ais-enhanced]').forEach(el => {
        delete el.dataset.aisEnhanced;
      });
      this.initialized = false;
    }
  };

  // ============================================================
  // Console API
  // ============================================================
  window.AIStudio = {
    API,
    Parser,
    Exporters,
    MessageEnhancer,

    async list() {
      const prompts = await API.getAllPrompts();
      return Parser.parsePromptList(prompts);
    },

    async get(promptId) {
      const data = await API.getConversation(promptId);
      return Parser.parseConversation(data);
    },

    async search(query) {
      const all = await this.list();
      const q = query.toLowerCase();
      return all.filter(p => p.title.toLowerCase().includes(q));
    },

    async stats() {
      const prompts = await API.getAllPrompts();
      let total = { tokens: 0, thinking: 0, messages: 0, chats: prompts.length };

      console.log(`Sampling first 10 of ${prompts.length} chats for stats...`);
      for (const p of prompts.slice(0, 10)) {
        const data = await API.getConversation(p[0]);
        const conv = Parser.parseConversation(data);
        const s = Exporters.getStats(conv);
        total.tokens += s.totalTokens;
        total.thinking += s.thinkingTokens;
        total.messages += s.messageCount;
      }

      return total;
    }
  };

  // Init
  UI.init();
  MessageEnhancer.init();
  console.log('%c📥 AI Studio Exporter v1.3 loaded', 'color: #4a9eff; font-weight: bold;');
  console.log('   Click the button in top-right, or use window.AIStudio');
  console.log('   🗑️ Delete buttons added to message toolbars');
})();
