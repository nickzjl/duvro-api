/**
 * Tests for the provider boundary. Node's built-in test runner — no
 * dependencies, matching the repo's zero-dependency invariant.
 *
 *   node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generate,
  getProvider,
  getProviderConfig,
  PROVIDERS,
  ProviderConfigError,
  ProviderError,
  ProviderTimeoutError,
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
} from '../lib/imageProvider.js';

const IMAGE = { url: 'https://example.invalid/photo.jpg', mediaType: 'image/jpeg' };

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

test('config defaults to the stub provider with sane concurrency and timeout', () => {
  const config = getProviderConfig({});
  assert.equal(config.name, 'stub');
  assert.equal(config.concurrency, DEFAULT_CONCURRENCY);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('concurrency comes from the environment, never hardcoded at the call site', () => {
  assert.equal(getProviderConfig({ IMAGE_PROVIDER_CONCURRENCY: '7' }).concurrency, 7);
  assert.equal(getProviderConfig({ IMAGE_PROVIDER_CONCURRENCY: '1' }).concurrency, 1);
});

test('timeout comes from the environment', () => {
  assert.equal(getProviderConfig({ IMAGE_PROVIDER_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
});

test('out-of-range or non-integer tuning is rejected, not silently coerced', () => {
  assert.throws(() => getProviderConfig({ IMAGE_PROVIDER_CONCURRENCY: '0' }), ProviderConfigError);
  assert.throws(() => getProviderConfig({ IMAGE_PROVIDER_CONCURRENCY: '999' }), ProviderConfigError);
  assert.throws(() => getProviderConfig({ IMAGE_PROVIDER_CONCURRENCY: 'lots' }), ProviderConfigError);
  assert.throws(() => getProviderConfig({ IMAGE_PROVIDER_TIMEOUT_MS: '10' }), ProviderConfigError);
});

test('an unknown provider name is rejected with the valid names listed', () => {
  assert.throws(
    () => getProviderConfig({ IMAGE_PROVIDER: 'some-model-i-have-not-picked' }),
    (err) => err instanceof ProviderConfigError && err.message.includes('stub'),
  );
});

test('provider selection is case-insensitive and trimmed', () => {
  assert.equal(getProviderConfig({ IMAGE_PROVIDER: '  STUB  ' }).name, 'stub');
});

test('getProvider throws for a name not in the registry', () => {
  assert.throws(() => getProvider('nope'), ProviderConfigError);
});

/* ------------------------------------------------------------------ */
/* The stub                                                            */
/* ------------------------------------------------------------------ */

test('stub returns the input image unchanged', async () => {
  const result = await generate({ image: IMAGE, instruction: 'anything', env: {} });
  assert.equal(result.url, IMAGE.url);
  assert.equal(result.mediaType, 'image/jpeg');
});

test('stub can be made to fail deterministically, for exercising fallback', async () => {
  await assert.rejects(
    generate({ image: IMAGE, instruction: 'x', env: { IMAGE_PROVIDER_STUB_FAIL_RATE: '1' } }),
    (err) => err instanceof ProviderError && err.retryable === true,
  );
});

test('stub with fail rate 0 never fails', async () => {
  for (let i = 0; i < 20; i++) {
    await generate({ image: IMAGE, instruction: 'x', env: { IMAGE_PROVIDER_STUB_FAIL_RATE: '0' } });
  }
});

/* ------------------------------------------------------------------ */
/* Timeout                                                             */
/* ------------------------------------------------------------------ */

test('a slow generation raises ProviderTimeoutError, distinguishable from a plain failure', async () => {
  const slow = {
    name: 'slow',
    generate: () => new Promise(() => {}), // never settles
  };
  await assert.rejects(
    generate({ image: IMAGE, instruction: 'x', provider: slow, timeoutMs: 30, env: {} }),
    (err) => {
      assert.ok(err instanceof ProviderTimeoutError, 'expected ProviderTimeoutError');
      assert.ok(err instanceof ProviderError, 'timeout should still be a ProviderError');
      assert.equal(err.code, 'provider_timeout');
      assert.equal(err.timeoutMs, 30);
      return true;
    },
  );
});

test('the timeout aborts the signal the provider was handed', async () => {
  let sawAbort = false;
  const watcher = {
    name: 'watcher',
    generate: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('aborted'));
      }, { once: true });
    }),
  };
  await assert.rejects(generate({ image: IMAGE, instruction: 'x', provider: watcher, timeoutMs: 20, env: {} }));
  assert.equal(sawAbort, true);
});

test('a timeout is reported as a timeout even when the provider throws something else on abort', async () => {
  const noisy = {
    name: 'noisy',
    generate: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new TypeError('socket hang up')), { once: true });
    }),
  };
  await assert.rejects(
    generate({ image: IMAGE, instruction: 'x', provider: noisy, timeoutMs: 20, env: {} }),
    ProviderTimeoutError,
  );
});

test('a fast generation is not affected by the timeout', async () => {
  const fast = { name: 'fast', generate: async () => ({ url: 'https://example.invalid/out.jpg', mediaType: 'image/jpeg' }) };
  const result = await generate({ image: IMAGE, instruction: 'x', provider: fast, timeoutMs: 5000, env: {} });
  assert.equal(result.url, 'https://example.invalid/out.jpg');
});

/* ------------------------------------------------------------------ */
/* Error mapping                                                       */
/* ------------------------------------------------------------------ */

test("a provider's raw error message never escapes — it can quote request content", async () => {
  const leaky = {
    name: 'leaky',
    generate: async () => { throw new Error('failed on user photo IMG_4471.HEIC at s3://bucket/private'); },
  };
  await assert.rejects(
    generate({ image: IMAGE, instruction: 'x', provider: leaky, env: {} }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.message, 'generation failed');
      assert.ok(!err.message.includes('IMG_4471'));
      return true;
    },
  );
});

test('a ProviderError raised by the provider passes through with its retryable flag intact', async () => {
  const permanent = {
    name: 'permanent',
    generate: async () => {
      throw new ProviderError('content rejected', { code: 'content_rejected', retryable: false });
    },
  };
  await assert.rejects(
    generate({ image: IMAGE, instruction: 'x', provider: permanent, env: {} }),
    (err) => err.code === 'content_rejected' && err.retryable === false,
  );
});

test('ProviderError defaults to retryable, so an unknown failure still gets its second chance', () => {
  assert.equal(new ProviderError('boom').retryable, true);
});

/* ------------------------------------------------------------------ */
/* Registry shape                                                      */
/* ------------------------------------------------------------------ */

test('every registered provider exposes the one required function', () => {
  for (const [name, impl] of Object.entries(PROVIDERS)) {
    assert.equal(typeof impl.generate, 'function', `${name}.generate must be a function`);
    assert.equal(impl.name, name, `${name}.name must match its registry key`);
  }
});
