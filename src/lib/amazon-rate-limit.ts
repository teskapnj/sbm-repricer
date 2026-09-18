export const AMAZON_RATE_LIMITS = {
    competitiveSummary: 0.033,
    itemOffersBatch: 0.1,
  } as const;
  
  export function sleep(ms: number) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  
  export function getAmazonRateLimit(
    response: Response,
    fallbackRps: number,
  ) {
    const header =
      response.headers.get(
        "x-amzn-ratelimit-limit",
      );
  
    if (!header) {
      return fallbackRps;
    }
  
    const value = Number(
      header.split(",")[0]?.trim(),
    );
  
    if (
      !Number.isFinite(value) ||
      value <= 0
    ) {
      return fallbackRps;
    }
  
    return value;
  }
  
  export function getAmazonRequestDelayMs(
    response: Response,
    fallbackRps: number,
  ) {
    const requestsPerSecond =
      getAmazonRateLimit(
        response,
        fallbackRps,
      );
  
    // Small safety margin so we don't sit exactly
    // on Amazon's rate-limit boundary.
    return Math.ceil(
      1000 / requestsPerSecond,
    ) + 250;
  }
  
  function getRetryAfterMs(
    response: Response,
  ) {
    const retryAfter =
      response.headers.get(
        "retry-after",
      );
  
    if (!retryAfter) {
      return null;
    }
  
    const seconds =
      Number(retryAfter);
  
    if (
      Number.isFinite(seconds) &&
      seconds >= 0
    ) {
      return seconds * 1000;
    }
  
    const retryDate =
      Date.parse(retryAfter);
  
    if (
      Number.isFinite(retryDate)
    ) {
      return Math.max(
        0,
        retryDate - Date.now(),
      );
    }
  
    return null;
  }
  
  export async function amazonFetchWithRetry(
    input: string | URL,
    init: RequestInit,
    fallbackRps: number,
    maxRetries = 5,
  ) {
    let attempt = 0;
  
    while (true) {
      const response =
        await fetch(
          input,
          init,
        );
  
      const rateLimitRps =
        getAmazonRateLimit(
          response,
          fallbackRps,
        );
  
      const nextDelayMs =
        getAmazonRequestDelayMs(
          response,
          fallbackRps,
        );
  
      const retryable =
        response.status === 429 ||
        response.status === 503;
  
      if (
        !retryable ||
        attempt >= maxRetries
      ) {
        return {
          response,
          rateLimitRps,
          nextDelayMs,
        };
      }
  
      const retryAfterMs =
        getRetryAfterMs(
          response,
        );
  
      const exponentialBackoff =
        Math.min(
          nextDelayMs *
            Math.pow(
              2,
              attempt + 1,
            ),
          120_000,
        );
  
      const waitMs =
        retryAfterMs ??
        exponentialBackoff;
  
      console.warn(
        `Amazon throttled request (${response.status}). ` +
          `Retrying in ${waitMs}ms.`,
      );
  
      await sleep(waitMs);
  
      attempt++;
    }
  }