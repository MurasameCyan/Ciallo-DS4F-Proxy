/**
 * 上游错误分类只依赖状态码和错误体,不依赖网关状态机,方便转发与能力探测共用。
 */
export function upstreamErrorMessage(body) {
  if (body && typeof body === 'object') {
    return String(body?.error?.message || body?.message || '').trim();
  }
  const text = String(body ?? '');
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message;
    if (message) return String(message).trim();
  } catch {}
  return text.trim();
}

export function isModelUnavailableError(status, body) {
  if (Number(status) !== 400) return false;
  return /\bmodel\s+(?:(?:is|was)\s+)?(?:unavailable|not\s+available)\b/i
    .test(upstreamErrorMessage(body));
}

export function isCapabilityError(status, body) {
  const code = Number(status);
  if (code !== 400 && code !== 422) return false;
  if (isModelUnavailableError(code, body)) return false;
  const message = upstreamErrorMessage(body);
  return !/\b(?:unauthorized|forbidden|invalid\s+(?:api[_ -]?key|token)|authentication)\b/i.test(message);
}

export function classifyUpstreamError(status, body) {
  const code = Number(status) || 0;
  if (code === 429) return 'rate_limited';
  if (code === 0) return 'transport';
  if (isModelUnavailableError(code, body)) return 'model_unavailable';
  if (code === 408 || code >= 500) return 'retryable';
  return 'terminal';
}
