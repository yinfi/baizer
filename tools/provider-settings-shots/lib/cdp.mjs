/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Uses only Node built-ins (global `fetch` + global `WebSocket`, both available
 * in Node >= 22), so the capture harness has no third-party dependencies and
 * needs no install step of its own.
 */

import { setTimeout as delay } from 'node:timers/promises';

export async function httpJson(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Block until Electron's DevTools HTTP endpoint answers. */
export async function waitForDevTools(port, { timeoutMs = 180000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await httpJson(`http://127.0.0.1:${port}/json/version`, 3000);
    } catch (err) {
      lastError = err;
      await delay(intervalMs);
    }
  }
  throw new Error(
    `DevTools endpoint on 127.0.0.1:${port} unreachable within ${timeoutMs} ms (${lastError?.message})`,
  );
}

export async function listTargets(port) {
  return httpJson(`http://127.0.0.1:${port}/json/list`, 5000);
}

/**
 * Obsidian is Electron, so the main window appears as a `page` target served
 * from `app://obsidian.md/`. Prefer that one; fall back to any page target.
 */
export function pickPageTarget(targets) {
  const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const obsidian = pages.filter((t) => /obsidian/i.test(t.url || ''));
  return obsidian[0] || pages[0] || null;
}

export async function waitForPageTarget(port, { timeoutMs = 120000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const target = pickPageTarget(await listTargets(port));
      if (target) return target;
    } catch {
      /* endpoint not up yet */
    }
    await delay(intervalMs);
  }
  throw new Error(`No Obsidian page target appeared on port ${port} within ${timeoutMs} ms`);
}

export class CDPSession {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => this.#failAll(new Error('CDP socket closed')));
    ws.addEventListener('error', () => this.#failAll(new Error('CDP socket error')));
  }

  static async connect(wsUrl, { timeoutMs = 20000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${wsUrl}`)), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${wsUrl}`));
      }, { once: true });
    });
    return new CDPSession(ws);
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message || 'CDP error'} (code ${msg.error.code})`));
      else entry.resolve(msg.result);
      return;
    }
    const handlers = this.#listeners.get(msg.method);
    if (handlers) for (const handler of [...handlers]) handler(msg.params);
  }

  #failAll(error) {
    this.#closed = true;
    for (const [, entry] of this.#pending) entry.reject(error);
    this.#pending.clear();
  }

  send(method, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP session is closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(handler);
    return () => this.#listeners.get(method)?.delete(handler);
  }

  /**
   * Evaluate an expression in the page and return its value by value.
   * `awaitPromise` lets callers await async Obsidian APIs.
   */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 60000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise, userGesture: true },
      { timeoutMs },
    );
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.exception?.value ||
        result.exceptionDetails.text ||
        'unknown';
      throw new Error(`Page exception: ${detail}`);
    }
    return result.result?.value;
  }

  /** Poll a page-side expression until it returns truthy. */
  async waitFor(expression, { timeoutMs = 60000, intervalMs = 300, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evaluate(expression);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await delay(intervalMs);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${label} (last=${JSON.stringify(last)})`);
  }

  close() {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}
