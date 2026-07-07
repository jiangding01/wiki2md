export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function createConcurrencyLimiter(maxConcurrent: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (maxConcurrent <= 0 || active < maxConcurrent) {
        active++;
        resolve();
        return;
      }
      waiters.push(() => {
        active++;
        resolve();
      });
    });

  const release = () => {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  };

  return async <T>(fn: () => Promise<T>) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export async function fetchWithRetry(url: string, init: RequestInit, retries: number) {
  let lastError: any = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return response;

      if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      return response;
    } catch (e) {
      lastError = e;
      if (attempt < retries) {
        await sleep(300 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastError;
}

