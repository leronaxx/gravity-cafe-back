/**
 * Провайдеры языковой модели.
 *
 * Проект не привязан к одному поставщику ИИ. Есть три реализации с одинаковым
 * интерфейсом (chat / chatStream / ping):
 *
 *   ollama  — локальная модель на своём компьютере (бесплатно, без интернета);
 *   openai  — любой сервер, совместимый с OpenAI API: OpenAI, DeepSeek,
 *             OpenRouter, YandexGPT через прокси, локальный vLLM и т.д.
 *             Отличается только базовый URL и ключ;
 *   mock    — режим без языковой модели (детерминированный поиск по базе).
 *
 * Смена провайдера делается одной строкой в .env — это называется
 * «абстракция над LLM-провайдером» и снимает зависимость от одного вендора.
 */

import { assistantConfig } from "./config.js";
import { fallbackAnswer } from "./fallback.js";

export class ProviderError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = meta.status || null;
    this.provider = meta.provider || null;
  }
}

/**
 * Приводит вызовы инструментов к единому виду.
 * OpenAI отдаёт аргументы строкой JSON, Ollama — готовым объектом.
 */
export function normalizeToolCalls(rawCalls, providerName = "unknown") {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls
    .filter((call) => call && (call.function?.name || call.name))
    .map((call, index) => {
      let args = call.function?.arguments ?? call.arguments ?? {};
      if (typeof args === "string") {
        try {
          args = JSON.parse(args || "{}");
        } catch {
          args = {};
        }
      }
      return {
        id: call.id || `${providerName}-call-${index}-${Date.now()}`,
        name: call.function?.name || call.name,
        arguments: args || {},
      };
    });
}

/** Общая проверка HTTP-ответа. */
async function assertOk(response, provider) {
  if (response.ok) return response;
  const text = await response.text().catch(() => "");
  throw new ProviderError(`${provider}: HTTP ${response.status} ${text.slice(0, 300)}`, {
    status: response.status,
    provider,
  });
}

/** Разбор потока строк в формате NDJSON (используется Ollama). */
async function* readNdjson(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // неполная или служебная строка — пропускаем
      }
    }
  }
  const tail = buffer.trim();
  if (tail) {
    try {
      yield JSON.parse(tail);
    } catch {
      /* ignore */
    }
  }
}

/** Разбор потока Server-Sent Events (используется OpenAI-совместимыми API). */
async function* readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex;
    while ((separatorIndex = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          yield JSON.parse(payload);
        } catch {
          /* ignore */
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Ollama — локальный запуск модели
 * ------------------------------------------------------------------ */

export function createOllamaProvider(cfg = assistantConfig.ollama) {
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");

  async function request(messages, options = {}) {
    const body = {
      model: cfg.model,
      messages: prepareMessages(messages, "ollama"),
      stream: Boolean(options.stream),
      options: {
        temperature: options.temperature ?? assistantConfig.generation.temperature,
        num_predict: options.maxTokens ?? assistantConfig.generation.maxTokens,
      },
    };
    if (options.tools?.length) body.tools = options.tools;

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    return assertOk(response, "ollama");
  }

  return {
    name: "ollama",
    model: cfg.model,
    supportsTools: true,

    async ping() {
      try {
        const response = await fetch(`${baseUrl}/api/tags`, {
          signal: AbortSignal.timeout(2500),
        });
        if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
        const data = await response.json();
        const models = (data.models || []).map((model) => model.name);
        const hasModel = models.some((name) => name === cfg.model || name.startsWith(cfg.model.split(":")[0]));
        return {
          ok: true,
          models,
          hasModel,
          reason: hasModel ? null : `модель ${cfg.model} не найдена, выполните: ollama pull ${cfg.model}`,
        };
      } catch (error) {
        return { ok: false, reason: `Ollama недоступна: ${error.message}` };
      }
    },

    async chat(messages, options = {}) {
      const response = await request(messages, options);
      const data = await response.json();
      return {
        content: data.message?.content || "",
        toolCalls: normalizeToolCalls(data.message?.tool_calls, "ollama"),
        usage: {
          promptTokens: data.prompt_eval_count ?? null,
          completionTokens: data.eval_count ?? null,
        },
      };
    },

    async *chatStream(messages, options = {}) {
      const response = await request(messages, { ...options, stream: true });
      let content = "";
      let toolCalls = [];
      let usage = { promptTokens: null, completionTokens: null };

      for await (const chunk of readNdjson(response.body)) {
        const delta = chunk.message?.content;
        if (delta) {
          content += delta;
          yield { type: "delta", text: delta };
        }
        if (chunk.message?.tool_calls?.length) {
          toolCalls = normalizeToolCalls(chunk.message.tool_calls, "ollama");
        }
        if (chunk.done) {
          usage = {
            promptTokens: chunk.prompt_eval_count ?? null,
            completionTokens: chunk.eval_count ?? null,
          };
        }
      }

      yield { type: "final", content, toolCalls, usage };
    },
  };
}

/* ------------------------------------------------------------------ *
 *  OpenAI-совместимый API
 * ------------------------------------------------------------------ */

export function createOpenAIProvider(cfg = assistantConfig.openai) {
  const baseUrl = cfg.baseUrl.replace(/\/$/, "");

  function headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    };
  }

  async function request(messages, options = {}) {
    const body = {
      model: cfg.model,
      messages: prepareMessages(messages, "openai"),
      temperature: options.temperature ?? assistantConfig.generation.temperature,
      max_tokens: options.maxTokens ?? assistantConfig.generation.maxTokens,
      stream: Boolean(options.stream),
    };
    if (options.tools?.length) {
      body.tools = options.tools;
      body.tool_choice = "auto";
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    return assertOk(response, "openai");
  }

  return {
    name: "openai",
    model: cfg.model,
    supportsTools: true,

    async ping() {
      if (!cfg.apiKey) return { ok: false, reason: "не задан OPENAI_API_KEY" };
      try {
        const response = await fetch(`${baseUrl}/models`, {
          headers: headers(),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },

    async chat(messages, options = {}) {
      const response = await request(messages, options);
      const data = await response.json();
      const choice = data.choices?.[0]?.message || {};
      return {
        content: choice.content || "",
        toolCalls: normalizeToolCalls(choice.tool_calls, "openai"),
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? null,
          completionTokens: data.usage?.completion_tokens ?? null,
        },
      };
    },

    async *chatStream(messages, options = {}) {
      const response = await request(messages, { ...options, stream: true });
      let content = "";
      // OpenAI присылает tool_calls по частям, склеиваем их по index.
      const partial = new Map();

      for await (const chunk of readSse(response.body)) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          content += delta.content;
          yield { type: "delta", text: delta.content };
        }

        for (const call of delta.tool_calls || []) {
          const index = call.index ?? 0;
          const current = partial.get(index) || { id: null, function: { name: "", arguments: "" } };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.function.name += call.function.name;
          if (call.function?.arguments) current.function.arguments += call.function.arguments;
          partial.set(index, current);
        }
      }

      const toolCalls = normalizeToolCalls(
        [...partial.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
        "openai"
      );
      yield { type: "final", content, toolCalls, usage: { promptTokens: null, completionTokens: null } };
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Mock — режим без языковой модели
 * ------------------------------------------------------------------ */

/**
 * Провайдер-«поисковик»: не обращается к нейросети, а отвечает
 * детерминированным алгоритмом по базе знаний и базе данных.
 * Нужен как страховка и как эталон для сравнения на защите.
 */
export function createMockProvider({ pool, retrieve }) {
  return {
    name: "mock",
    model: "knowledge-search",
    supportsTools: false,

    async ping() {
      return { ok: true, reason: "детерминированный режим без языковой модели" };
    },

    async chat(messages, options = {}) {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const result = await fallbackAnswer({
        message: lastUser?.content || "",
        pool,
        retrieve,
        context: options.context || null,
      });
      return {
        content: result.reply,
        toolCalls: [],
        usage: { promptTokens: null, completionTokens: null },
        meta: { intent: result.intent, internalToolCalls: result.toolCalls, sources: result.sources },
      };
    },

    async *chatStream(messages, options = {}) {
      const result = await this.chat(messages, options);
      // Отдаём ответ небольшими порциями, чтобы фронтенд показал «печать».
      const pieces = result.content.match(/[\s\S]{1,24}/g) || [result.content];
      for (const piece of pieces) {
        yield { type: "delta", text: piece };
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
      yield { type: "final", content: result.content, toolCalls: [], usage: result.usage, meta: result.meta };
    },
  };
}

/* ------------------------------------------------------------------ *
 *  Приведение сообщений к формату провайдера
 * ------------------------------------------------------------------ */

/**
 * Внутри агент работает с нейтральным форматом сообщений.
 * Здесь мы превращаем их в то, что понимает конкретный API.
 */
export function prepareMessages(messages, providerName) {
  return messages.map((message) => {
    if (message.role === "assistant" && message.tool_calls) {
      if (providerName === "openai") {
        return {
          role: "assistant",
          content: message.content || null,
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
          })),
        };
      }
      // Ollama понимает объект с аргументами и не требует id.
      return {
        role: "assistant",
        content: message.content || "",
        tool_calls: message.tool_calls.map((call) => ({
          function: { name: call.name, arguments: call.arguments || {} },
        })),
      };
    }

    if (message.role === "tool") {
      if (providerName === "openai") {
        return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
      }
      return { role: "tool", content: message.content, tool_name: message.name };
    }

    return { role: message.role, content: message.content };
  });
}

/* ------------------------------------------------------------------ *
 *  Выбор провайдера
 * ------------------------------------------------------------------ */

let resolved = null;
let resolvedAt = 0;
const RESOLVE_TTL_MS = 60_000;

/**
 * Определяет, какой провайдер реально доступен.
 *
 * Логика:
 *   1. Явно указанный в .env провайдер — пробуем его.
 *   2. Если он недоступен, НЕ падаем с ошибкой, а включаем mock-режим
 *      и помечаем ответ флагом degraded. Сайт остаётся рабочим.
 */
export async function resolveProvider({ deps, force = false, logger = console } = {}) {
  const now = Date.now();
  if (!force && resolved && now - resolvedAt < RESOLVE_TTL_MS) return resolved;

  const requested = assistantConfig.provider;
  const build = (provider, degraded, reason) => ({
    provider,
    degraded,
    reason,
    mode: provider.name,
    requested,
  });

  const mock = () => createMockProvider(deps);

  if (requested === "mock") {
    resolved = build(mock(), false, "ASSISTANT_PROVIDER=mock");
    resolvedAt = now;
    return resolved;
  }

  if (requested === "openai") {
    const provider = createOpenAIProvider();
    const ping = await provider.ping();
    if (ping.ok) {
      resolved = build(provider, false, null);
    } else {
      logger.warn?.(`[assistant] OpenAI-провайдер недоступен: ${ping.reason}. Включаю режим без модели.`);
      resolved = build(mock(), true, ping.reason);
    }
    resolvedAt = now;
    return resolved;
  }

  if (requested === "ollama") {
    const provider = createOllamaProvider();
    const ping = await provider.ping();
    if (ping.ok && ping.hasModel !== false) {
      resolved = build(provider, false, ping.reason || null);
    } else {
      logger.warn?.(`[assistant] Ollama недоступна: ${ping.reason}. Включаю режим без модели.`);
      resolved = build(mock(), true, ping.reason);
    }
    resolvedAt = now;
    return resolved;
  }

  // auto: сначала локальная модель, затем облако (если есть ключ), затем mock
  const ollama = createOllamaProvider();
  const ollamaPing = await ollama.ping();
  if (ollamaPing.ok && ollamaPing.hasModel !== false) {
    resolved = build(ollama, false, null);
    resolvedAt = now;
    return resolved;
  }

  if (assistantConfig.openai.apiKey) {
    const openai = createOpenAIProvider();
    const openaiPing = await openai.ping();
    if (openaiPing.ok) {
      resolved = build(openai, false, null);
      resolvedAt = now;
      return resolved;
    }
    logger.warn?.(`[assistant] OpenAI-совместимый API недоступен: ${openaiPing.reason}`);
  }

  resolved = build(mock(), true, ollamaPing.reason || "языковая модель не настроена");
  resolvedAt = now;
  return resolved;
}

export function resetProviderCache() {
  resolved = null;
  resolvedAt = 0;
}

export default {
  createOllamaProvider,
  createOpenAIProvider,
  createMockProvider,
  resolveProvider,
  normalizeToolCalls,
  prepareMessages,
};
