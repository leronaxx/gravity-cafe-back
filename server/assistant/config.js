import "dotenv/config";

/**
 * Конфигурация ИИ-ассистента.
 *
 * Всё читается из переменных окружения, поэтому один и тот же код
 * работает и с локальной моделью в Ollama, и с облачным
 * OpenAI-совместимым API (OpenAI, DeepSeek, OpenRouter, YandexGPT через
 * прокси и т.д.). Меняется только содержимое .env — код не меняется.
 */

function num(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const provider = (process.env.ASSISTANT_PROVIDER || "auto").toLowerCase();

export const assistantConfig = {
  // auto | ollama | openai | mock
  // auto — пробуем выбранный провайдер, при недоступности включаем mock
  // (поиск по базе знаний без языковой модели), чтобы сайт не ломался.
  provider,

  // --- Ollama (локальный запуск языковой модели) ---
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model: process.env.OLLAMA_MODEL || "qwen2.5:7b-instruct",
    // сколько миллисекунд ждём ответ модели
    timeoutMs: num(process.env.OLLAMA_TIMEOUT_MS, 120000),
  },

  // --- Любой OpenAI-совместимый API ---
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    timeoutMs: num(process.env.OPENAI_TIMEOUT_MS, 60000),
  },

  // --- Параметры генерации ---
  generation: {
    // низкая температура = меньше «фантазии», для справочных ответов это важно
    temperature: Number.parseFloat(process.env.ASSISTANT_TEMPERATURE || "0.3"),
    maxTokens: num(process.env.ASSISTANT_MAX_TOKENS, 700),
    // сколько кусков базы знаний подставлять в контекст (top-K RAG)
    topK: num(process.env.ASSISTANT_TOP_K, 4),
    // максимальное число шагов «модель -> вызов инструмента -> модель»
    maxToolIterations: num(process.env.ASSISTANT_MAX_TOOL_ITERATIONS, 4),
    // сколько последних сообщений диалога помнить
    historyLimit: num(process.env.ASSISTANT_HISTORY_LIMIT, 10),
  },

  // --- Ограничения и защита ---
  limits: {
    maxMessageLength: num(process.env.ASSISTANT_MAX_MESSAGE_LENGTH, 1000),
    rateLimitWindowMs: num(process.env.ASSISTANT_RATE_WINDOW_MS, 60000),
    rateLimitMax: num(process.env.ASSISTANT_RATE_MAX, 20),
  },

  // --- Логирование диалогов в PostgreSQL ---
  logging: bool(process.env.ASSISTANT_LOGGING, true),

  promptVersion: process.env.ASSISTANT_PROMPT_VERSION || "1.0.0",
};

export default assistantConfig;
