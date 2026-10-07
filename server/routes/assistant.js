import { Router } from "express";
import crypto from "node:crypto";

import pool from "../db.js";
import { assistantConfig } from "../assistant/config.js";
import { runAssistant, streamAssistant, getMenuSnapshot, invalidateMenuCache } from "../assistant/agent.js";
import { resolveProvider } from "../assistant/providers.js";
import { retrieve, loadKnowledgeBase } from "../assistant/retriever.js";
import { ensureAssistantSchema, getStats, saveFeedback } from "../assistant/logger.js";
import { rateLimit } from "../assistant/rateLimit.js";
import { TOOL_SPECS } from "../assistant/tools.js";

/**
 * HTTP-интерфейс ИИ-ассистента.
 *
 *   POST /api/assistant/chat          — обычный ответ (JSON)
 *   POST /api/assistant/chat/stream   — ответ потоком (Server-Sent Events)
 *   POST /api/assistant/feedback      — оценка ответа гостем
 *   GET  /api/assistant/health        — какой провайдер доступен
 *   GET  /api/assistant/stats         — статистика диалогов
 *   GET  /api/assistant/suggestions   — подсказки-кнопки для чата
 *   GET  /api/assistant/knowledge     — оглавление базы знаний
 *   GET  /api/assistant/tools         — список инструментов (для отладки)
 */

const router = Router();

const limiter = rateLimit({
  windowMs: assistantConfig.limits.rateLimitWindowMs,
  max: assistantConfig.limits.rateLimitMax,
});

/** Проверяет и нормализует тело запроса. */
function parseChatRequest(body) {
  const errors = [];
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!message) errors.push("Поле message обязательно");
  if (message.length > assistantConfig.limits.maxMessageLength) {
    errors.push(`Сообщение длиннее ${assistantConfig.limits.maxMessageLength} символов`);
  }

  const history = Array.isArray(body?.history)
    ? body.history
        .filter((item) => item && typeof item.content === "string")
        .slice(-assistantConfig.generation.historyLimit)
        .map((item) => ({
          role: item.role === "assistant" ? "assistant" : "user",
          content: item.content.slice(0, 2000),
        }))
    : [];

  let context = null;
  if (body?.context && typeof body.context === "object") {
    context = {
      page: typeof body.context.page === "string" ? body.context.page.slice(0, 60) : null,
      cart: Array.isArray(body.context.cart)
        ? body.context.cart.slice(0, 20).map((item) => ({
            name: String(item?.name || "").slice(0, 80),
            quantity: Math.max(1, Math.min(99, Number.parseInt(item?.quantity, 10) || 1)),
            price: Number.parseInt(item?.price, 10) || 0,
          }))
        : [],
    };
  }

  const sessionId = typeof body?.sessionId === "string" && body.sessionId.length <= 64
    ? body.sessionId
    : crypto.randomUUID();

  return { message, history, context, sessionId, errors };
}

/* --------------------------- Обычный ответ --------------------------- */

router.post("/chat", limiter, async (req, res) => {
  const { message, history, context, sessionId, errors } = parseChatRequest(req.body);

  if (errors.length) {
    return res.status(400).json({ error: errors.join("; "), sessionId });
  }

  try {
    const result = await runAssistant({ pool, message, history, context, sessionId });
    return res.json(result);
  } catch (error) {
    console.error("POST /api/assistant/chat error:", error);
    return res.status(500).json({
      error: "Ассистент временно недоступен. Позвоните нам: +7 (495) 123-45-67.",
      sessionId,
    });
  }
});

/* ------------------------- Потоковый ответ (SSE) ------------------------- */

router.post("/chat/stream", limiter, async (req, res) => {
  const { message, history, context, sessionId, errors } = parseChatRequest(req.body);

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (errors.length) {
    send({ type: "error", error: errors.join("; "), sessionId });
    send({ type: "done", reply: "", sessionId });
    return res.end();
  }

  // Отслеживаем обрыв соединения гостём.
  // Важно: слушаем событие 'close' у ОТВЕТА (res), а не у запроса (req).
  // У req событие 'close' срабатывает сразу после того, как тело запроса
  // прочитано, — если слушать req, поток всегда будет считаться прерванным.
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableEnded) clientGone = true;
  });

  try {
    for await (const event of streamAssistant({ pool, message, history, context, sessionId })) {
      if (clientGone) break;
      send(event);
    }
  } catch (error) {
    console.error("POST /api/assistant/chat/stream error:", error);
    if (!clientGone) send({ type: "error", error: "Ассистент временно недоступен." });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

/* ------------------------------ Обратная связь ------------------------------ */

router.post("/feedback", async (req, res) => {
  const rating = Number.parseInt(req.body?.rating, 10);
  if (![1, -1].includes(rating)) {
    return res.status(400).json({ error: "rating должен быть 1 (полезно) или -1 (не полезно)" });
  }
  try {
    const saved = await saveFeedback(pool, {
      messageId: Number.parseInt(req.body?.messageId, 10) || null,
      sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId.slice(0, 64) : null,
      rating,
      comment: typeof req.body?.comment === "string" ? req.body.comment.slice(0, 1000) : null,
    });
    return res.json({ ok: true, id: saved.id });
  } catch (error) {
    console.error("POST /api/assistant/feedback error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* -------------------------------- Служебные -------------------------------- */

router.get("/health", async (req, res) => {
  try {
    await ensureAssistantSchema(pool);
    const { provider, degraded, reason } = await resolveProvider({
      deps: { pool, retrieve },
      force: req.query.force === "1",
    });
    const menu = await getMenuSnapshot(pool, { force: req.query.force === "1" });
    return res.json({
      status: "ok",
      provider: provider.name,
      model: provider.model,
      degraded,
      reason: reason || null,
      requested_provider: assistantConfig.provider,
      tools: TOOL_SPECS.map((spec) => spec.function.name),
      knowledge_chunks: loadKnowledgeBase().length,
      menu_items: menu.length,
      prompt_version: assistantConfig.promptVersion,
    });
  } catch (error) {
    console.error("GET /api/assistant/health error:", error);
    return res.status(500).json({ status: "error", error: error.message });
  }
});

router.get("/stats", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 7, 1), 365);
    const stats = await getStats(pool, { days });
    return res.json(stats);
  } catch (error) {
    console.error("GET /api/assistant/stats error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/suggestions", (req, res) => {
  res.json({
    suggestions: [
      "Что посоветуете к кофе?",
      "Сколько калорий в тирамису?",
      "Есть ли блюда до 300 ккал?",
      "Какие у вас вегетарианские блюда?",
      "По какому адресу вы находитесь?",
      "До скольки вы работаете в выходные?",
      "Расскажите историю вашего кафе",
      "Помогите выбрать десерт",
    ],
  });
});

router.get("/knowledge", (req, res) => {
  const chunks = loadKnowledgeBase();
  const topics = {};
  for (const chunk of chunks) {
    topics[chunk.topic] = topics[chunk.topic] || [];
    topics[chunk.topic].push(chunk.title);
  }
  res.json({ total: chunks.length, topics });
});

router.get("/tools", (req, res) => {
  res.json({
    tools: TOOL_SPECS.map((spec) => ({
      name: spec.function.name,
      description: spec.function.description,
      parameters: spec.function.parameters,
    })),
  });
});

/** Сброс кэша меню — удобно после изменения блюд в админке. */
router.post("/refresh", (req, res) => {
  invalidateMenuCache();
  res.json({ ok: true });
});

export default router;
