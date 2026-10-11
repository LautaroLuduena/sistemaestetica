// Envoltorio de fetch para las integraciones (reemplazable en los tests).
const http = {
  fetch: (...args) => globalThis.fetch(...args),

  async json(url, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
    const res = await http.fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const detail = data && typeof data === 'object' ? data.message || data.description || data.error || JSON.stringify(data) : text;
      const err = new Error(`HTTP ${res.status}: ${detail}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
};

module.exports = http;
