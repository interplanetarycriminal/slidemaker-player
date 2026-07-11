// js/openrouter-client.js — browser OpenRouter client for SlideMaker Studio (BYOK).
// Plain ES2022 module. Zero dependencies.
//
// The API key is held in a private field, sent ONLY as the Authorization
// header, and scrubbed out of every error message this module produces.
// It must never be logged, exported, or embedded in any payload.

const API_BASE = 'https://openrouter.ai/api/v1';

/** 429 backoff ladder (used when no Retry-After header is present). */
const BACKOFF_MS = [5000, 15000, 45000];
const MAX_429_RETRIES = 3;

export class OutOfCreditsError extends Error {
  constructor(message = 'OpenRouter returned 402 — out of credits') {
    super(message);
    this.name = 'OutOfCreditsError';
    this.status = 402;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenRouterClient {
  #key = '';

  /** Set (or clear) the bearer key. Never stored anywhere else by this module. */
  setKey(key) {
    this.#key = String(key || '').trim();
  }

  get hasKey() {
    return this.#key.length > 0;
  }

  /** Remove the key from arbitrary text before it can reach the UI or console. */
  scrubText(text) {
    const s = String(text ?? '');
    return this.#key ? s.split(this.#key).join('[KEY REDACTED]') : s;
  }

  #headers(withJson) {
    const h = {
      'Authorization': `Bearer ${this.#key}`,
      'HTTP-Referer': location.origin,
      'X-Title': 'SlideMaker Studio',
    };
    if (withJson) h['Content-Type'] = 'application/json';
    return h;
  }

  /**
   * Core request wrapper.
   *  - 402  -> OutOfCreditsError (caller shows the banner and stops)
   *  - 429  -> honors Retry-After (seconds) else 5s/15s/45s, max 3 retries
   *  - !ok  -> Error with a scrubbed, truncated server detail
   * @returns parsed JSON, or the raw Response when opts.raw is true
   */
  async #request(path, { method = 'GET', body, auth = true, raw = false } = {}) {
    if (auth && !this.hasKey) {
      throw new Error('NO API KEY — open the key drawer and paste one');
    }
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetch(API_BASE + path, {
          method,
          headers: auth
            ? this.#headers(body !== undefined)
            : (body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        throw new Error(this.scrubText(`network error calling ${path} — ${err && err.message || err}`));
      }

      if (res.status === 402) throw new OutOfCreditsError();

      if (res.status === 429 && attempt < MAX_429_RETRIES) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
        attempt += 1;
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        let detail = '';
        try {
          const text = await res.text();
          try {
            const parsed = JSON.parse(text);
            detail = (parsed && parsed.error && (parsed.error.message || parsed.error)) || text;
          } catch {
            detail = text;
          }
        } catch { /* body unreadable — status alone will do */ }
        detail = String(detail || '').slice(0, 200);
        throw new Error(this.scrubText(
          `HTTP ${res.status} from ${path}${detail ? ' — ' + detail : ''}`,
        ));
      }

      if (raw) return res;
      try {
        return await res.json();
      } catch {
        throw new Error(this.scrubText(`unparseable JSON from ${path}`));
      }
    }
  }

  /** GET /auth/key -> { limit_remaining, expires_at, ... } */
  async checkKey() {
    const j = await this.#request('/auth/key');
    return (j && j.data) ?? j;
  }

  /** GET /credits -> { total_credits, total_usage } */
  async getCredits() {
    const j = await this.#request('/credits');
    return (j && j.data) ?? j;
  }

  /**
   * GET /videos/models (NO auth) -> array of model descriptors:
   *   { id, supported_frame_images, supported_durations, supported_resolutions, ... }
   */
  async listVideoModels() {
    const j = await this.#request('/videos/models', { auth: false });
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.data)) return j.data;
    return [];
  }

  /**
   * POST /videos -> 202 { id, status }.
   * firstFrame / lastFrame are data: URLs of the 1280x720 normalized PNGs.
   */
  async createVideoJob({
    model, prompt, duration,
    firstFrame, lastFrame,
    resolution = '720p', aspectRatio = '16:9', seed = 42,
  }) {
    const j = await this.#request('/videos', {
      method: 'POST',
      body: {
        model,
        prompt,
        duration,
        resolution,
        aspect_ratio: aspectRatio,
        generate_audio: false,
        seed,
        frame_images: [
          { type: 'image_url', image_url: { url: firstFrame }, frame_type: 'first_frame' },
          { type: 'image_url', image_url: { url: lastFrame }, frame_type: 'last_frame' },
        ],
      },
    });
    return (j && j.data) ?? j;
  }

  /** GET /videos/{id} -> { status: pending|in_progress|completed|failed|cancelled|expired, usage:{cost}, error } */
  async getVideoJob(id) {
    const j = await this.#request(`/videos/${encodeURIComponent(id)}`);
    return (j && j.data) ?? j;
  }

  /** GET /videos/{id}/content?index=0 -> mp4 bytes as a Blob. */
  async downloadVideoContent(id, index = 0) {
    const res = await this.#request(
      `/videos/${encodeURIComponent(id)}/content?index=${index}`,
      { raw: true },
    );
    return await res.blob();
  }
}
