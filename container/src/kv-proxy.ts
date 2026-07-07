/**
 * Container-side proxy that implements Cloudflare's KVNamespace interface.
 * Routes KV calls (get, put, delete, list) to Worker bindings using the 
 * in-process outboundByHost mechanism (http://kv.internal).
 */
export class KvProxy {
  constructor(private readonly namespaceName: string) {}

  private async fetchWithRetry(url: string, init?: RequestInit, retries = 2): Promise<Response> {
    for (let i = 0; i <= retries; i++) {
      try {
        const res = await fetch(url, init);
        // Retry on 5xx or network errors. Keep-alive issues can cause socket drops.
        if (res.ok || res.status === 404 || i === retries) return res;
        console.warn(`[KvProxy] Fetch failed with status ${res.status}, retrying...`);
      } catch (err) {
        if (i === retries) throw err;
        console.warn(`[KvProxy] Fetch encountered error, retrying...`, err);
      }
      await new Promise(r => setTimeout(r, 100 * (i + 1)));
    }
    throw new Error('KvProxy request failed after retries');
  }

  async get<T = string>(key: string, type?: 'text' | 'json'): Promise<T | null> {
    const res = await this.fetchWithRetry(`http://kv.internal/${this.namespaceName}/get?key=${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`KV Proxy GET failed for ${this.namespaceName}/${key}: ${res.status} ${await res.text()}`);
    }
    const val = await res.text();
    if (type === 'json') {
      return JSON.parse(val) as T;
    }
    return val as any as T;
  }

  async getWithMetadata(key: string): Promise<{ value: string | null; metadata: any }> {
    const val = await this.get(key);
    return { value: val, metadata: {} };
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: any }): Promise<void> {
    const ttl = options?.expirationTtl ?? 0;
    const url = `http://kv.internal/${this.namespaceName}/put?key=${encodeURIComponent(key)}${ttl ? `&ttl=${ttl}` : ''}`;
    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      body: value,
    });
    if (!res.ok) {
      throw new Error(`KV Proxy PUT failed for ${this.namespaceName}/${key}: ${res.status} ${await res.text()}`);
    }
  }

  async delete(key: string): Promise<void> {
    const res = await this.fetchWithRetry(`http://kv.internal/${this.namespaceName}/delete?key=${encodeURIComponent(key)}`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`KV Proxy DELETE failed for ${this.namespaceName}/${key}: ${res.status} ${await res.text()}`);
    }
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string; metadata?: any }>; list_complete: boolean; cursor?: string }> {
    const params = new URLSearchParams();
    if (options?.prefix) params.append('prefix', options.prefix);
    if (options?.limit) params.append('limit', String(options.limit));
    if (options?.cursor) params.append('cursor', options.cursor);
    const query = params.toString() ? `?${params.toString()}` : '';
    
    const res = await this.fetchWithRetry(`http://kv.internal/${this.namespaceName}/list${query}`);
    if (!res.ok) {
      throw new Error(`KV Proxy LIST failed for ${this.namespaceName}: ${res.status} ${await res.text()}`);
    }
    return await res.json() as any;
  }
}
