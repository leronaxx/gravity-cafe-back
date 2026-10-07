/**
 * Простейшее ограничение частоты запросов (rate limiting).
 *
 * Смысл: ассистент обращается к языковой модели, а это платный и не бесконечно
 * быстрый ресурс. Без ограничения один гость (или скрипт) может «залить»
 * сервер сотнями запросов и создать очередь.
 *
 * Алгоритм — скользящее окно в памяти процесса:
 *   для каждого IP храним список времени запросов, при новом запросе
 *   выбрасываем всё старше окна и проверяем количество.
 *
 * Для одного сервера этого достаточно. Если серверов несколько, счётчик
 * нужно вынести в Redis — об этом стоит сказать на защите как о плане развития.
 */

const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 20, keyGenerator } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const key = keyGenerator ? keyGenerator(req) : req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();

    const timestamps = (buckets.get(key) || []).filter((time) => now - time < windowMs);
    timestamps.push(now);
    buckets.set(key, timestamps);

    const remaining = Math.max(0, max - timestamps.length);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));

    if (timestamps.length > max) {
      const retryAfter = Math.ceil((windowMs - (now - timestamps[0])) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Слишком много запросов. Пожалуйста, подождите немного.",
        retry_after_seconds: retryAfter,
      });
    }

    return next();
  };
}

/** Периодическая очистка, чтобы карта не росла бесконечно. */
export function startRateLimitCleanup({ intervalMs = 300_000, windowMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of buckets) {
      const fresh = timestamps.filter((time) => now - time < windowMs);
      if (fresh.length) buckets.set(key, fresh);
      else buckets.delete(key);
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export default rateLimit;
