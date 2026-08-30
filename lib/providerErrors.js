/**
 * The error types the provider boundary speaks in.
 *
 * Extracted from lib/imageProvider.js so a concrete provider can throw them
 * without importing the registry that imports the provider — a cycle.
 * lib/imageProvider.js re-exports all three, so every existing import path
 * keeps working.
 */

/**
 * `retryable` drives the batch layer's retry-once policy. It defaults to true
 * so an unrecognized failure gets its second chance — but a provider that
 * *knows* a retry is pointless (a rejected prompt, an unsupported image
 * format) should say so, because burning a second call on it costs money and
 * delays the fallback the user is waiting on.
 */
export class ProviderError extends Error {
  constructor(message, { code = 'provider_error', retryable = true, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** Distinguishable from every other failure — the batch layer reports it separately. */
export class ProviderTimeoutError extends ProviderError {
  constructor(timeoutMs) {
    super(`generation exceeded ${timeoutMs}ms`, { code: 'provider_timeout', retryable: true });
    this.name = 'ProviderTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class ProviderConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}
