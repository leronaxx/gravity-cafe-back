/**
 * Тест полного цикла function calling.
 *
 * Здесь мы поднимаем настоящий HTTP-сервер, который притворяется
 * OpenAI-совместимым API, и проверяем, что агент:
 *   1. отправляет модели описание инструментов;
 *   2. получает запрос на вызов инструмента;
 *   3. сам выполняет SQL-запрос;
 *   4. возвращает результат модели и получает финальный ответ;
 *   5. умеет делать то же самое в режиме потока (SSE).
 *
 * Никаких обращений в интернет: всё происходит на 127.0.0.1.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

/* ---------- 1. Поднимаем заглушку API ---------- */

const requests = [];

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      /* ignore */
    }
    requests.push(payload);

    const hasToolResult = (payload.messages || []).some((message) => message.role === "tool");
    const finalText = "В тирамису 420 ккал, белки 7 г, жиры 26 г, углеводы 38 г.";

    if (payload.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);

      if (hasToolResult) {
        for (const piece of ["В тирамису ", "420 ккал, ", "белки 7 г."]) send({ content: piece });
      } else {
        // Модель «печатает» вызов инструмента по частям — как это делает OpenAI.
        send({ tool_calls: [{ index: 0, id: "call_stream", function: { name: "get_menu_item", arguments: "" } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: '{"name":' } }] });
        send({ tool_calls: [{ index: 0, function: { arguments: '"Тирамису"}' } }] });
      }

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    if (hasToolResult) {
      return res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: finalText } }],
          usage: { prompt_tokens: 320, completion_tokens: 24 },
        })
      );
    }
    return res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "get_menu_item", arguments: '{"name":"Тирамису"}' } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 250, completion_tokens: 12 },
      })
    );
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/* ---------- 2. Настраиваем окружение ДО загрузки модулей ---------- */

process.env.ASSISTANT_PROVIDER = "openai";
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.OPENAI_API_KEY = "test-key";
process.env.OPENAI_MODEL = "stub-model";
process.env.ASSISTANT_LOGGING = "false";
// Этот файл проверяет путь через языковую модель, поэтому гибридную
// маршрутизацию отключаем: иначе фактические вопросы уходили бы
// в детерминированный поиск и не доходили до модели.
process.env.ASSISTANT_ROUTING = "llm";

const { runAssistant, streamAssistant, invalidateMenuCache } = await import("../assistant/agent.js");

/* ---------- 3. Заглушка базы данных ---------- */

const TIramisuRow = {
  id: 7, name: "Тирамису", description: "Классический итальянский десерт с маскарпоне",
  price: 450, prep_time: 5, calories: 420, proteins: "7.0", fats: "26.0", carbs: "38.0",
  is_vegetarian: true, allergens: ["молоко", "глютен", "яйца"], category: "desserts",
};

const pool = {
  queries: [],
  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (/FROM cafe_settings/.test(sql)) {
      return {
        rows: [
          { key: "address", value: "Ростов-На-Дону, ул. Пушкинская, 151" },
          { key: "phone", value: "+7 (495) 123-45-67" },
          { key: "hours_weekday", value: "08:00 — 23:00" },
          { key: "hours_weekend", value: "09:00 — 00:00" },
          { key: "founded_year", value: "2025" },
          { key: "about_text", value: "Gravity Café — тёплый свет и живая музыка." },
        ],
      };
    }
    if (/SELECT m\.name, m\.price, m\.calories, m\.prep_time/.test(sql)) {
      return { rows: [{ name: "Тирамису", price: 450, calories: 420, prep_time: 5, is_vegetarian: true, category: "desserts" }] };
    }
    if (/WHERE LOWER\(m\.name\) = LOWER\(\$1\)/.test(sql)) {
      return { rows: params[0] === "Тирамису" ? [TIramisuRow] : [] };
    }
    return { rows: [] };
  },
};

/* ---------- 4. Тесты ---------- */

test.after(() => server.close());

test("агент выполняет полный цикл function calling с OpenAI-совместимым API", async () => {
  invalidateMenuCache();
  requests.length = 0;
  pool.queries.length = 0;

  const result = await runAssistant({ pool, message: "Сколько калорий в тирамису?", sessionId: "fc-test" });

  // 1. Ответ получен от модели, а не от фолбэка.
  assert.equal(result.provider, "openai");
  assert.equal(result.degraded, false);
  assert.match(result.reply, /420 ккал/);
  assert.equal(result.usage.promptTokens, 320);

  // 2. Модель реально попросила вызвать инструмент, и он попал в метаданные ответа.
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "get_menu_item");
  assert.deepEqual(result.toolCalls[0].arguments, { name: "Тирамису" });

  // 3. Агент сам сходил в базу данных.
  assert.ok(
    pool.queries.some((query) => /WHERE LOWER\(m\.name\) = LOWER\(\$1\)/.test(query.sql)),
    "агент должен выполнить SQL-запрос к menu_items"
  );

  // 4. Ровно два обращения к модели: запрос инструмента и финальный ответ.
  assert.equal(requests.length, 2, "цикл должен завершиться за два шага");

  // 5. Модели передали описание инструментов и результат их выполнения.
  assert.equal(requests[0].tools.length, 5);
  assert.equal(requests[0].tool_choice, "auto");
  const toolMessage = requests[1].messages.find((message) => message.role === "tool");
  assert.ok(toolMessage, "результат инструмента должен вернуться модели");
  assert.match(toolMessage.content, /420/, "в модель уходит реальная калорийность из БД");
  assert.equal(toolMessage.tool_call_id, "call_1");
});

test("в системный промпт попадают база знаний (RAG) и меню из БД", async () => {
  invalidateMenuCache();
  requests.length = 0;
  await runAssistant({ pool, message: "Что посоветуете к кофе?" });

  const systemPrompt = requests[0].messages[0];
  assert.equal(systemPrompt.role, "system");
  assert.match(systemPrompt.content, /Gravity Café/);
  assert.match(systemPrompt.content, /АКТУАЛЬНОЕ МЕНЮ ИЗ БАЗЫ ДАННЫХ/);
  assert.match(systemPrompt.content, /Тирамису 450₽ 420ккал 5мин/, "меню берётся из базы данных");
  assert.ok(systemPrompt.content.length > 1500, "промпт должен содержать найденные факты");
});

test("агент не зацикливается, если модель бесконечно просит инструмент", async () => {
  // Отдельный сервер, который всегда просит вызвать инструмент.
  const loopServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "loop", type: "function", function: { name: "get_cafe_info", arguments: "{}" } }],
              },
            },
          ],
        })
      );
    });
  });
  await new Promise((resolve) => loopServer.listen(0, "127.0.0.1", resolve));
  const loopPort = loopServer.address().port;

  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${loopPort}/v1`;
  const { resetProviderCache } = await import("../assistant/providers.js");
  resetProviderCache();

  const { assistantConfig } = await import("../assistant/config.js");
  const originalBase = assistantConfig.openai.baseUrl;
  assistantConfig.openai.baseUrl = `http://127.0.0.1:${loopPort}/v1`;

  try {
    invalidateMenuCache();
    const result = await runAssistant({ pool, message: "Сколько калорий в тирамису?" });
    // Главное: запрос не завис и вернулся осмысленный ответ.
    assert.ok(result.reply.length > 0);
  } finally {
    assistantConfig.openai.baseUrl = originalBase;
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    resetProviderCache();
    loopServer.close();
  }
});

test("потоковый режим (SSE) отдаёт ответ по частям", async () => {
  invalidateMenuCache();
  requests.length = 0;

  const events = [];
  for await (const event of streamAssistant({ pool, message: "Сколько калорий в тирамису?", sessionId: "stream-fc" })) {
    events.push(event);
  }

  const types = events.map((event) => event.type);
  assert.equal(types[0], "meta");
  assert.equal(types.at(-1), "done");

  const meta = events[0];
  assert.equal(meta.provider, "openai");
  assert.equal(meta.degraded, false);

  const done = events.at(-1);
  assert.match(done.reply, /420 ккал/);
  assert.equal(done.toolCalls.length, 1);

  const streamed = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
  assert.equal(streamed, done.reply, "склеенные delta должны давать итоговый ответ");

  // Модель вызывалась в потоковом режиме.
  assert.ok(requests.some((request) => request.stream === true), "должен быть запрос со stream: true");
});

test("если языковая модель падает в середине ответа, ассистент отвечает по базе знаний", async () => {
  // Сервер, который сначала работает (отдаёт вызов инструмента),
  // а на следующем запросе «ломается» — как перезапущенная Ollama.
  let chatCalls = 0;
  const flakyServer = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      chatCalls++;
      if (chatCalls === 1) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    { id: "c1", type: "function", function: { name: "get_cafe_info", arguments: "{}" } },
                  ],
                },
              },
            ],
          })
        );
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "model crashed" }));
    });
  });

  await new Promise((resolve) => flakyServer.listen(0, "127.0.0.1", resolve));

  const { assistantConfig } = await import("../assistant/config.js");
  const { resetProviderCache } = await import("../assistant/providers.js");
  const originalBaseUrl = assistantConfig.openai.baseUrl;
  assistantConfig.openai.baseUrl = `http://127.0.0.1:${flakyServer.address().port}/v1`;
  resetProviderCache();

  const silentLogger = { error() {}, warn() {}, log() {} };

  try {
    invalidateMenuCache();
    const result = await runAssistant({
      pool,
      message: "По какому адресу вы находитесь?",
      logger: silentLogger,
    });

    // Главное: гость получил осмысленный ответ, а не сообщение об ошибке.
    assert.match(result.reply, /Пушкинская, 151/);
    assert.equal(result.provider, "openai", "провайдер остаётся тем же — упал только конкретный запрос");
    assert.equal(chatCalls, 2, "должны быть две попытки: вызов инструмента и упавший запрос");
  } finally {
    assistantConfig.openai.baseUrl = originalBaseUrl;
    resetProviderCache();
    flakyServer.close();
  }
});

test("потоковый режим тоже переживает падение модели", async () => {
  let chatCalls = 0;
  const flakyServer = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      chatCalls++;
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "temporarily unavailable" }));
    });
  });

  await new Promise((resolve) => flakyServer.listen(0, "127.0.0.1", resolve));

  const { assistantConfig } = await import("../assistant/config.js");
  const { resetProviderCache } = await import("../assistant/providers.js");
  const originalBaseUrl = assistantConfig.openai.baseUrl;
  assistantConfig.openai.baseUrl = `http://127.0.0.1:${flakyServer.address().port}/v1`;
  resetProviderCache();

  const silentLogger = { error() {}, warn() {}, log() {} };

  try {
    invalidateMenuCache();
    const events = [];
    for await (const event of streamAssistant({
      pool,
      message: "До скольки вы работаете?",
      logger: silentLogger,
    })) {
      events.push(event);
    }

    const done = events.at(-1);
    assert.equal(done.type, "done");
    assert.match(done.reply, /23:00|выходные|работ/i, "ответ должен быть содержательным");
    assert.ok(chatCalls >= 1);
  } finally {
    assistantConfig.openai.baseUrl = originalBaseUrl;
    resetProviderCache();
    flakyServer.close();
  }
});
