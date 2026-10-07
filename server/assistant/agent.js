/**
 * Агент — «мозг» ассистента, который связывает все части вместе.
 *
 * Полный конвейер обработки вопроса (это схема для главы диплома):
 *
 *   вопрос гостя
 *        │
 *        ├─ 1. Проверка ограничений (длина, частота запросов)
 *        ├─ 2. RAG-поиск: TF-IDF по базе знаний -> top-K фактов
 *        ├─ 3. Снимок меню из PostgreSQL (цены, калории, БЖУ)
 *        ├─ 4. Сборка системного промпта с этими данными
 *        ├─ 5. Вызов языковой модели с описанием инструментов
 *        │      └─ цикл: модель просит данные -> SQL-запрос -> модель снова
 *        ├─ 6. Ответ модели гостю + список использованных источников
 *        └─ 7. Запись диалога в таблицу assistant_messages
 *
 * Ключевая идея: модель никогда не «вспоминает» цены и калории, а получает
 * их из базы данных. Это устраняет главную проблему генеративных моделей —
 * галлюцинации (выдумывание фактов).
 */

import { assistantConfig } from "./config.js";
import { retrieve } from "./retriever.js";
import { TOOL_SPECS, executeTool, buildMenuSnapshot } from "./tools.js";
import { buildSystemPrompt, buildMessages } from "./prompt.js";
import { resolveProvider } from "./providers.js";
import { logExchange } from "./logger.js";
import { fallbackAnswer, detectIntent } from "./fallback.js";

/* ------------------------------------------------------------------ *
 *  Гибридная маршрутизация
 * ------------------------------------------------------------------ */

/**
 * Вопросы, ответ на которые обязан быть точным: калорийность, состав,
 * аллергены, цены, подбор по ограничениям, адрес, часы работы, контакты.
 *
 * Такие запросы обслуживает детерминированный поиск (fallback.js): он берёт
 * данные из PostgreSQL и базы знаний и не может «придумать» цифру. Языковая
 * модель подключается там, где нужен живой текст: рекомендации, история кафе,
 * общие вопросы.
 *
 * Почему так: небольшие локальные модели (3–7 млрд параметров) иногда путают
 * инструменты и факты — например, называют вегетарианские блюда «не
 * содержащими молока». Для калорийности и аллергенов цена ошибки высока
 * (это здоровье гостя), поэтому такие ответы генерации мы не доверяем.
 */
const DETERMINISTIC_INTENTS = new Set([
  "calories",
  "price",
  "allergens",
  "vegetarian",
  "address",
  "hours",
  "contacts",
  "menu_overview",
  "popular",
  "reservation",
  "ordering",
  "amenities",
]);

/** Нужно ли отвечать без языковой модели (только точные данные). */
export function shouldAnswerDeterministically(message) {
  if (assistantConfig.generation.routing !== "hybrid") return false;
  return DETERMINISTIC_INTENTS.has(detectIntent(message));
}

/** Готовит детерминированный ответ и приводит его к общему формату. */
async function deterministicAnswer({ pool, message, context, knowledge }) {
  const result = await fallbackAnswer({ message, pool, retrieve, context });
  return {
    content: result.reply,
    toolCalls: result.toolCalls,
    sources: result.sources.length
      ? result.sources
      : knowledge.map((chunk) => ({
          id: chunk.id, title: chunk.title, topic: chunk.topic, score: chunk.score,
        })),
    intent: result.intent,
  };
}

/* ------------------------------------------------------------------ *
 *  Кэш выжимки меню
 * ------------------------------------------------------------------ */

let menuCache = { data: null, at: 0 };
const MENU_CACHE_TTL_MS = 30_000;

/**
 * Отдаёт актуальное меню из БД, но не чаще раза в 30 секунд.
 * Зачем кэш: при каждом сообщении мы подкладываем модели список меню,
 * а это лишний SQL-запрос на каждое слово гостя.
 */
export async function getMenuSnapshot(pool, { force = false } = {}) {
  const now = Date.now();
  if (!force && menuCache.data && now - menuCache.at < MENU_CACHE_TTL_MS) {
    return menuCache.data;
  }
  const data = await buildMenuSnapshot(pool);
  menuCache = { data, at: now };
  return data;
}

export function invalidateMenuCache() {
  menuCache = { data: null, at: 0 };
}

/* ------------------------------------------------------------------ *
 *  Подготовка
 * ------------------------------------------------------------------ */

function sanitizeContext(context) {
  if (!context || typeof context !== "object") return null;
  const cart = Array.isArray(context.cart)
    ? context.cart.slice(0, 20).map((item) => ({
        name: String(item?.name || "").slice(0, 80),
        quantity: Math.max(1, Math.min(99, Number.parseInt(item?.quantity, 10) || 1)),
        price: Number.parseInt(item?.price, 10) || 0,
      }))
    : [];
  return {
    page: context.page ? String(context.page).slice(0, 60) : null,
    cart,
  };
}

function truncateToolResult(result) {
  const json = JSON.stringify(result);
  // Ограничиваем размер, чтобы не раздувать промпт (и не тратить токены).
  return json.length > 4000 ? `${json.slice(0, 4000)}...` : json;
}

/**
 * Готовит «мозговой штурм» перед вызовом модели:
 * находит знания, берёт меню и собирает сообщения.
 */
export async function prepare({ pool, message, history = [], context = null }) {
  const cleanHistory = history.slice(-assistantConfig.generation.historyLimit);
  const cleanContext = sanitizeContext(context);

  // Шаг RAG: ищем факты по текущему вопросу.
  // Если вопрос короткий и непонятный («а сколько?»), добавляем предыдущую
  // реплику гостя — так поиск работает даже в диалоге с уточнениями.
  const lastUser = [...cleanHistory].reverse().find((item) => item?.role === "user");
  const query = lastUser && message.trim().split(/\s+/).length <= 3
    ? `${lastUser.content} ${message}`
    : message;

  const knowledge = retrieve(query, { topK: assistantConfig.generation.topK });
  const menu = await getMenuSnapshot(pool);
  const systemPrompt = buildSystemPrompt({ knowledge, menu, context: cleanContext });
  const messages = buildMessages({ systemPrompt, history: cleanHistory, message });

  return { knowledge, menu, messages, context: cleanContext };
}

/* ------------------------------------------------------------------ *
 *  Основной проход (без стриминга)
 * ------------------------------------------------------------------ */

export async function runAssistant({
  pool,
  message,
  history = [],
  context = null,
  sessionId = null,
  logger = console,
}) {
  const startedAt = Date.now();
  const text = String(message || "").trim();

  if (!text) {
    return { reply: "Пожалуйста, напишите вопрос — я помогу с выбором блюд и напитков.", error: "EMPTY_MESSAGE" };
  }

  const { knowledge, messages, context: cleanContext } = await prepare({ pool, message: text, history, context });

  // Гибридная маршрутизация: точные факты — детерминированным поиском,
  // свободный диалог — языковой моделью. Подробности в комментарии выше.
  const route = shouldAnswerDeterministically(text) ? "deterministic" : "llm";

  let provider = { name: "knowledge-search", model: "поиск по базе", supportsTools: false };
  let degraded = false;
  let reason = null;
  if (route === "llm") {
    ({ provider, degraded, reason } = await resolveProvider({ deps: { pool, retrieve }, logger }));
  }

  const usedTools = [];
  let reply = "";
  let usage = { promptTokens: null, completionTokens: null };
  let meta = null;

  try {
    if (route === "deterministic") {
      const result = await deterministicAnswer({ pool, message: text, context: cleanContext, knowledge });
      reply = result.content;
      meta = { intent: result.intent, internalToolCalls: result.toolCalls, sources: result.sources };
    } else if (!provider.supportsTools) {
      // Режим без языковой модели: детерминированный ответ.
      const result = await provider.chat(messages, { context: cleanContext });
      reply = result.content;
      usage = result.usage || usage;
      meta = result.meta || null;
    } else {
      const conversation = [...messages];
      for (let iteration = 0; iteration < assistantConfig.generation.maxToolIterations; iteration++) {
        const result = await provider.chat(conversation, {
          tools: TOOL_SPECS,
          context: cleanContext,
        });
        usage = result.usage || usage;

        if (!result.toolCalls.length) {
          reply = result.content;
          break;
        }

        // Модель попросила данные — выполняем запросы и возвращаем результат.
        conversation.push({ role: "assistant", content: result.content || "", tool_calls: result.toolCalls });
        for (const call of result.toolCalls) {
          usedTools.push({ name: call.name, arguments: call.arguments });
          const toolResult = await executeTool(call.name, call.arguments, { pool, retrieve });
          conversation.push({
            role: "tool",
            name: call.name,
            tool_call_id: call.id,
            content: truncateToolResult(toolResult),
          });
        }
      }

      if (!reply) {
        // Дошли до лимита шагов, но модель так и не дала финальный текст.
        reply = "Не удалось подготовить ответ. Попробуйте переформулировать вопрос или позвоните нам: +7 (495) 123-45-67.";
      }
    }
  } catch (error) {
    // Модель может «упасть» уже во время ответа: сеть, таймаут, перезапуск.
    // В этом случае не отдаём гостю ошибку, а отвечаем детерминированно.
    logger.error?.("[assistant] ошибка провайдера, переключаюсь на поиск по базе знаний:", error.message);
    const result = await fallbackFromProviderError({ pool, message: text, context: cleanContext, knowledge });
    reply = result.content;
    meta = result.meta || null;
  }

  const latencyMs = Date.now() - startedAt;
  const sources = meta?.sources || knowledge.map((chunk) => ({ id: chunk.id, title: chunk.title, topic: chunk.topic, score: chunk.score }));
  const allTools = meta?.internalToolCalls ? [...meta.internalToolCalls, ...usedTools] : usedTools;

  const payload = {
    reply,
    sources,
    toolCalls: allTools,
    usage,
    route,
    provider: route === "deterministic" ? "knowledge-search" : degraded ? "mock" : provider.name,
    model: route === "deterministic" ? "детерминированный поиск" : degraded ? "knowledge-search" : provider.model,
    degraded,
    degradedReason: degraded ? reason : null,
    latencyMs,
    sessionId,
    promptVersion: assistantConfig.promptVersion,
  };

  await logExchange({
    sessionId,
    question: text,
    answer: reply,
    payload,
    logger,
  });

  return payload;
}

/**
 * Резервный проход, если провайдер упал в момент ответа (таймаут, обрыв сети,
 * перезапуск локальной модели). Гость не должен увидеть ошибку — он получит
 * ответ из базы знаний, а в логе останется пометка degraded.
 */
async function fallbackFromProviderError({ pool, message, context, knowledge }) {
  const { fallbackAnswer } = await import("./fallback.js");
  const result = await fallbackAnswer({ message, pool, retrieve, context });
  return {
    content: result.reply,
    meta: {
      intent: result.intent,
      internalToolCalls: result.toolCalls,
      sources: result.sources.length
        ? result.sources
        : knowledge.map((chunk) => ({ id: chunk.id, title: chunk.title, topic: chunk.topic, score: chunk.score })),
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Стриминг (ответ появляется у гостя по мере генерации)
 * ------------------------------------------------------------------ */

/**
 * Асинхронный генератор событий для SSE. Отдаёт:
 *   {type:'meta'}    — провайдер, найденные источники
 *   {type:'tool'}    — какой инструмент вызван
 *   {type:'reset'}   — очистить промежуточный текст (модель ушла за данными)
 *   {type:'delta'}   — очередная порция текста
 *   {type:'done'}    — итог: полный текст, источники, статистика
 */
export async function* streamAssistant({
  pool,
  message,
  history = [],
  context = null,
  sessionId = null,
  logger = console,
}) {
  const startedAt = Date.now();
  const text = String(message || "").trim();

  if (!text) {
    yield { type: "delta", text: "Пожалуйста, напишите вопрос — я помогу с выбором блюд и напитков." };
    yield { type: "done", reply: "", error: "EMPTY_MESSAGE" };
    return;
  }

  const { knowledge, messages, context: cleanContext } = await prepare({ pool, message: text, history, context });

  // Та же гибридная маршрутизация, что и в runAssistant.
  const route = shouldAnswerDeterministically(text) ? "deterministic" : "llm";

  let provider = { name: "knowledge-search", model: "поиск по базе", supportsTools: false };
  let degraded = false;
  let reason = null;
  if (route === "llm") {
    ({ provider, degraded, reason } = await resolveProvider({ deps: { pool, retrieve }, logger }));
  }

  yield {
    type: "meta",
    route,
    provider: route === "deterministic" ? "knowledge-search" : degraded ? "mock" : provider.name,
    model: route === "deterministic" ? "детерминированный поиск" : degraded ? "knowledge-search" : provider.model,
    degraded,
    degradedReason: degraded ? reason : null,
    sources: knowledge.map((chunk) => ({ id: chunk.id, title: chunk.title, topic: chunk.topic, score: chunk.score })),
  };

  const usedTools = [];
  let reply = "";
  let usage = { promptTokens: null, completionTokens: null };
  let meta = null;

  try {
    if (route === "deterministic") {
      // Точный ответ считаем сразу и отдаём его так же, как поток от модели,
      // чтобы фронтенд не знал разницы.
      const result = await deterministicAnswer({ pool, message: text, context: cleanContext, knowledge });
      reply = result.content;
      meta = { intent: result.intent, internalToolCalls: result.toolCalls, sources: result.sources };
      for (const call of result.toolCalls) {
        yield { type: "tool", name: call.name, arguments: call.arguments };
      }
      for (const piece of reply.match(/[\s\S]{1,24}/g) || [reply]) {
        yield { type: "delta", text: piece };
      }
    } else if (!provider.supportsTools) {
      // Mock-провайдер тоже умеет стримить: отдаёт текст порциями.
      for await (const event of provider.chatStream(messages, { context: cleanContext })) {
        if (event.type === "delta") {
          reply += event.text;
          yield { type: "delta", text: event.text };
        }
        if (event.type === "final") {
          usage = event.usage || usage;
          meta = event.meta || null;
          reply = event.content || reply;
        }
      }
    } else {
      const conversation = [...messages];
      let finished = false;

      for (let iteration = 0; iteration < assistantConfig.generation.maxToolIterations && !finished; iteration++) {
        let buffered = "";
        let toolCalls = [];

        for await (const event of provider.chatStream(conversation, {
          tools: TOOL_SPECS,
          context: cleanContext,
        })) {
          if (event.type === "delta") {
            buffered += event.text;
            yield { type: "delta", text: event.text };
          }
          if (event.type === "final") {
            toolCalls = event.toolCalls || [];
            usage = event.usage || usage;
            buffered = event.content || buffered;
          }
        }

        if (!toolCalls.length) {
          reply = buffered;
          finished = true;
          break;
        }

        // Модель сначала что-то написала, а потом ушла за данными —
        // просим фронтенд очистить пузырь, чтобы не показывать черновик.
        if (buffered) yield { type: "reset" };

        conversation.push({ role: "assistant", content: buffered, tool_calls: toolCalls });
        for (const call of toolCalls) {
          usedTools.push({ name: call.name, arguments: call.arguments });
          yield { type: "tool", name: call.name, arguments: call.arguments };
          const toolResult = await executeTool(call.name, call.arguments, { pool, retrieve });
          conversation.push({
            role: "tool",
            name: call.name,
            tool_call_id: call.id,
            content: truncateToolResult(toolResult),
          });
        }
      }

      if (!reply) {
        reply = "Не удалось подготовить ответ. Попробуйте переформулировать вопрос или позвоните нам: +7 (495) 123-45-67.";
        yield { type: "reset" };
        yield { type: "delta", text: reply };
      }
    }
  } catch (error) {
    logger.error?.("[assistant] ошибка стриминга, переключаюсь на поиск по базе знаний:", error.message);
    const result = await fallbackFromProviderError({ pool, message: text, context: cleanContext, knowledge });
    reply = result.content;
    meta = result.meta || null;
    yield { type: "reset" };
    yield { type: "delta", text: reply };
  }

  const latencyMs = Date.now() - startedAt;
  const sources = meta?.sources?.length
    ? meta.sources
    : knowledge.map((chunk) => ({ id: chunk.id, title: chunk.title, topic: chunk.topic, score: chunk.score }));
  const allTools = meta?.internalToolCalls ? [...meta.internalToolCalls, ...usedTools] : usedTools;

  const payload = {
    reply,
    sources,
    toolCalls: allTools,
    usage,
    route,
    provider: route === "deterministic" ? "knowledge-search" : degraded ? "mock" : provider.name,
    model: route === "deterministic" ? "детерминированный поиск" : degraded ? "knowledge-search" : provider.model,
    degraded,
    degradedReason: degraded ? reason : null,
    latencyMs,
    sessionId,
    promptVersion: assistantConfig.promptVersion,
  };

  await logExchange({ sessionId, question: text, answer: reply, payload, logger });

  yield { type: "done", ...payload };
}

export default { runAssistant, streamAssistant, prepare, getMenuSnapshot };
