/**
 * Юнит-тесты ИИ-ассистента (без обращения к языковой модели и к реальной БД).
 *
 * Запуск:  npm test        (из папки server)
 *
 * Тесты намеренно не зависят от Ollama и от PostgreSQL: вместо базы данных
 * подставляется «пул-заглушка», который возвращает заранее заданные строки.
 * Благодаря этому тесты быстро проходят на любом компьютере и в CI.
 */

// Переменные окружения выставляем ДО импорта модулей ассистента,
// потому что конфиг читает их при загрузке. Поэтому здесь динамический import.
process.env.ASSISTANT_PROVIDER = "mock";
process.env.ASSISTANT_LOGGING = "false";

import test from "node:test";
import assert from "node:assert/strict";

const { tokenize, normalizeToken, retrieve, buildIndex, search, loadKnowledgeBase } = await import(
  "../assistant/retriever.js"
);
const { normalizeCategory, normalizeAllergen, searchMenu, getMenuItem, buildMenuSnapshot, formatMenuItem, TOOL_SPECS } =
  await import("../assistant/tools.js");
const { normalizeToolCalls, prepareMessages, createOpenAIProvider } = await import("../assistant/providers.js");
const { detectIntent, extractNumber, fallbackAnswer } = await import("../assistant/fallback.js");
const { formatMenuSnapshot, buildSystemPrompt } = await import("../assistant/prompt.js");
const { runAssistant, streamAssistant, invalidateMenuCache } = await import("../assistant/agent.js");

/* ------------------------------------------------------------------ *
 *  Заглушка базы данных
 * ------------------------------------------------------------------ */

const MENU_ROWS = [
  { id: 7, name: "Тирамису", description: "Классический итальянский десерт с маскарпоне", price: 450, prep_time: 5, calories: 420, proteins: "7.0", fats: "26.0", carbs: "38.0", is_vegetarian: true, allergens: ["молоко", "глютен", "яйца"], category: "desserts" },
  { id: 3, name: "Эспрессо", description: "Крепкий итальянский кофе", price: 200, prep_time: 3, calories: 5, proteins: "0.3", fats: "0.1", carbs: "0.7", is_vegetarian: true, allergens: [], category: "drinks" },
  { id: 17, name: "Бургер с говядиной", description: "Сочный бургер с мраморной говядиной", price: 750, prep_time: 25, calories: 890, proteins: "42.0", fats: "48.0", carbs: "70.0", is_vegetarian: false, allergens: ["молоко", "глютен", "соя"], category: "meals" },
];

const SNAPSHOT_ROWS = [
  { name: "Тирамису", price: 450, calories: 420, prep_time: 5, is_vegetarian: true, category: "desserts" },
  { name: "Эспрессо", price: 200, calories: 5, prep_time: 3, is_vegetarian: true, category: "drinks" },
  { name: "Бургер с говядиной", price: 750, calories: 890, prep_time: 25, is_vegetarian: false, category: "meals" },
];

const SETTINGS_ROWS = [
  { key: "phone", value: "+7 (495) 123-45-67" },
  { key: "email", value: "info@gravitycafe.ru" },
  { key: "address", value: "Ростов-На-Дону, ул. Пушкинская, 151" },
  { key: "hours_weekday", value: "08:00 — 23:00" },
  { key: "hours_weekend", value: "09:00 — 00:00" },
  { key: "founded_year", value: "2025" },
  { key: "about_text", value: "Так появилось Gravity Café: тёплый свет, живая музыка и команда, которая помнит ваши любимые блюда." },
];

function createFakePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      for (const handler of handlers) {
        if (handler.match.test(sql)) {
          return { rows: typeof handler.rows === "function" ? handler.rows(params) : handler.rows };
        }
      }
      return { rows: [] };
    },
  };
}

const DEFAULT_HANDLERS = [
  { match: /FROM cafe_settings/, rows: SETTINGS_ROWS },
  { match: /SELECT m\.name, m\.price, m\.calories, m\.prep_time/, rows: SNAPSHOT_ROWS },
  { match: /FROM order_items oi/, rows: [] },
  { match: /m\.name IN \(/, rows: MENU_ROWS.slice(0, 2) },
  { match: /WHERE LOWER\(m\.name\) = LOWER\(\$1\)/, rows: (params) => (params[0] === "Тирамису" ? [MENU_ROWS[0]] : []) },
  { match: /LIKE \$1 OR LOWER\(\$2\)/, rows: [] },
  { match: /FROM menu_items m[\s\S]*JOIN categories c/, rows: MENU_ROWS },
];

function fakePool(extra = []) {
  return createFakePool([...extra, ...DEFAULT_HANDLERS]);
}

/* ------------------------------------------------------------------ *
 *  1. Ретривер (RAG-поиск по базе знаний)
 * ------------------------------------------------------------------ */

test("нормализация слов: ё заменяется, служебные слова и окончания отбрасываются", () => {
  assert.equal(normalizeToken("Ёлки"), "елк");
  assert.equal(normalizeToken("и"), "", "предлог должен отбрасываться");
  assert.equal(normalizeToken("калорийность"), normalizeToken("калорийности"));
  assert.equal(normalizeToken("цены"), normalizeToken("цена"), "разные падежи должны совпадать");

  const tokens = tokenize("Сколько калорий в Тирамису?");
  assert.ok(!tokens.includes("в"), "служебное слово отброшено");
  assert.ok(tokens.every((token) => token === token.toLowerCase()), "все слова в нижнем регистре");
  assert.ok(tokens.some((token) => token.startsWith("тирамис")), "окончание отрезано, слово приведено к основе");
});

test("база знаний загружается и содержит факты о кафе", () => {
  const chunks = loadKnowledgeBase();
  assert.ok(chunks.length >= 30, `ожидалось >= 30 фактов, получено ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.id && chunk.title && chunk.text, "у каждого факта должны быть id, title, text");
  }
});

test("поиск находит адрес кафе", () => {
  const found = retrieve("По какому адресу вы находитесь?", { topK: 3 });
  assert.ok(found.length > 0, "должен найтись хотя бы один факт");
  assert.ok(
    found.some((chunk) => /Пушкинская/.test(chunk.text)),
    "в результатах должен быть факт с адресом"
  );
});

test("поиск находит факты о калорийности", () => {
  const found = retrieve("сколько калорий в десерте и какой кбжу", { topK: 3 });
  assert.ok(found.some((chunk) => chunk.topic === "nutrition"));
});

test("поиск находит факты про вегетарианские блюда", () => {
  const found = retrieve("есть ли вегетарианские блюда без мяса", { topK: 3 });
  assert.ok(found.some((chunk) => /вегетариан/i.test(chunk.title + chunk.text)));
});

test("поиск находит историю кафе", () => {
  const found = retrieve("расскажите историю вашего кафе, когда вы открылись", { topK: 3 });
  assert.ok(found.some((chunk) => chunk.topic === "history"));
});

test("на бессмысленный запрос ретривер ничего не возвращает (нет галлюцинаций)", () => {
  const found = retrieve("zzz qqq вжух непонятночто", { topK: 3 });
  assert.equal(found.length, 0);
});

test("поиск ранжирует результаты по убыванию близости", () => {
  const index = buildIndex(loadKnowledgeBase());
  const results = search("часы работы в выходные", index, { topK: 5 });
  assert.ok(results.length > 1);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].score >= results[i].score, "оценки должны убывать");
  }
});

/* ------------------------------------------------------------------ *
 *  2. Инструменты (function calling) и SQL
 * ------------------------------------------------------------------ */

test("категория и аллерген приводятся к каноническому виду", () => {
  assert.equal(normalizeCategory("напитки"), "drinks");
  assert.equal(normalizeCategory("десерты"), "desserts");
  assert.equal(normalizeCategory("meals"), "meals");
  assert.equal(normalizeCategory("несуществующее"), null);
  assert.equal(normalizeAllergen("лактоза"), "молоко");
  assert.equal(normalizeAllergen("миндаль"), "орехи");
});

test("search_menu строит безопасный SQL с параметрами и фильтрами", async () => {
  const pool = fakePool();
  const result = await searchMenu(
    { max_calories: 300, vegetarian_only: true, exclude_allergens: ["орехи"], sort_by: "calories", limit: 3 },
    pool
  );

  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE/);
  assert.match(sql, /m\.calories <= \$1/, "калории должны фильтроваться параметром");
  assert.match(sql, /m\.is_vegetarian = TRUE/);
  assert.match(sql, /NOT \(m\.allergens && \$2::text\[\]\)/, "аллергены должны фильтроваться параметром-массивом");
  assert.match(sql, /ORDER BY m\.calories ASC/);
  assert.match(sql, /LIMIT \$3/);
  // Значения передаются отдельно от SQL — это защита от SQL-инъекций.
  assert.deepEqual(params, [300, ["орехи"], 3]);
  assert.equal(result.found, MENU_ROWS.length);
});

test("search_menu не подставляет произвольный ORDER BY (защита от инъекции)", async () => {
  const pool = fakePool();
  await searchMenu({ sort_by: "price; DROP TABLE menu_items" }, pool);
  assert.doesNotMatch(pool.calls[0].sql, /DROP TABLE/);
  assert.match(pool.calls[0].sql, /ORDER BY m\.calories ASC NULLS LAST/, "должна примениться сортировка по умолчанию");
});

test("get_menu_item находит блюдо по точному названию и возвращает КБЖУ", async () => {
  const pool = fakePool();
  const result = await getMenuItem({ name: "Тирамису" }, pool);
  assert.equal(result.match, "exact");
  assert.equal(result.item.calories, 420);
  assert.equal(result.item.proteins, 7, "числовые поля должны быть числами, а не строками");
  assert.equal(result.item.vegetarian, true);
  assert.deepEqual(result.item.allergens, ["молоко", "глютен", "яйца"]);
});

test("get_menu_item честно сообщает, что блюда нет в меню", async () => {
  const pool = fakePool();
  const result = await getMenuItem({ name: "Пицца Пепперони" }, pool);
  assert.equal(result.item, null);
  assert.match(result.error, /нет позиции/);
});

test("описание инструментов корректно для LLM (формат OpenAI tools)", () => {
  assert.equal(TOOL_SPECS.length, 5);
  for (const spec of TOOL_SPECS) {
    assert.equal(spec.type, "function");
    assert.ok(spec.function.name);
    assert.ok(spec.function.description.length > 20, "описание должно быть содержательным");
    assert.equal(spec.function.parameters.type, "object");
  }
  const names = TOOL_SPECS.map((spec) => spec.function.name);
  assert.deepEqual(names, ["search_menu", "get_menu_item", "get_cafe_info", "search_cafe_knowledge", "get_popular_items"]);
});

test("formatMenuItem терпимо относится к пустым значениям", () => {
  const item = formatMenuItem({ id: 1, name: "Тест", price: 100, prep_time: 5, calories: null, allergens: null });
  assert.equal(item.calories, null);
  assert.deepEqual(item.allergens, []);
  assert.equal(item.vegetarian, false);
});

/* ------------------------------------------------------------------ *
 *  3. Провайдеры: приведение форматов
 * ------------------------------------------------------------------ */

test("normalizeToolCalls понимает строковые аргументы (OpenAI) и объектные (Ollama)", () => {
  const openaiStyle = normalizeToolCalls([
    { id: "call_1", function: { name: "search_menu", arguments: '{"max_calories":300}' } },
  ]);
  assert.deepEqual(openaiStyle[0], { id: "call_1", name: "search_menu", arguments: { max_calories: 300 } });

  const ollamaStyle = normalizeToolCalls([{ function: { name: "get_cafe_info", arguments: { topic: "address" } } }]);
  assert.equal(ollamaStyle[0].name, "get_cafe_info");
  assert.deepEqual(ollamaStyle[0].arguments, { topic: "address" });
  assert.ok(ollamaStyle[0].id, "если id нет, он должен сгенерироваться");
});

test("normalizeToolCalls не падает на битом JSON", () => {
  const broken = normalizeToolCalls([{ function: { name: "search_menu", arguments: "{не json" } }]);
  assert.deepEqual(broken[0].arguments, {});
});

test("prepareMessages формирует корректные сообщения для OpenAI и Ollama", () => {
  const messages = [
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", name: "search_menu", arguments: { limit: 3 } }] },
    { role: "tool", name: "search_menu", tool_call_id: "call_1", content: '{"found":3}' },
  ];

  const forOpenai = prepareMessages(messages, "openai");
  assert.equal(forOpenai[0].tool_calls[0].id, "call_1");
  assert.equal(forOpenai[0].tool_calls[0].function.arguments, '{"limit":3}');
  assert.equal(forOpenai[1].role, "tool");
  assert.equal(forOpenai[1].tool_call_id, "call_1");

  const forOllama = prepareMessages(messages, "ollama");
  assert.deepEqual(forOllama[0].tool_calls[0].function.arguments, { limit: 3 });
  assert.equal(forOllama[1].tool_name, "search_menu");
});

/* ------------------------------------------------------------------ *
 *  4. Детерминированный режим (fallback)
 * ------------------------------------------------------------------ */

test("detectIntent распознаёт типовые вопросы гостей", () => {
  const cases = {
    "Привет!": "greeting",
    "По какому адресу вы находитесь?": "address",
    "До скольки вы работаете?": "hours",
    "Какой у вас телефон?": "contacts",
    "Сколько калорий в тирамису?": "calories",
    "Есть ли вегетарианские блюда?": "vegetarian",
    "У меня аллергия на орехи, что можно?": "allergens",
    "Расскажите историю кафе": "history",
    "Хочу забронировать столик на террасе": "reservation",
    "Как оформить предзаказ?": "ordering",
    "У вас есть wi-fi и розетки?": "amenities",
    "Что посоветуете к кофе?": "recommend",
  };
  for (const [question, expected] of Object.entries(cases)) {
    assert.equal(detectIntent(question), expected, `вопрос: ${question}`);
  }
});

test("extractNumber понимает ограничения из фразы", () => {
  assert.equal(extractNumber("покажи блюда до 300 ккал", ["ккал"]), 300);
  assert.equal(extractNumber("что-нибудь дешевле 400 рублей", ["руб"]), 400);
  assert.equal(extractNumber("просто совет", ["ккал"]), null);
});

test("fallback отвечает про адрес, калории и вегетарианское меню", async () => {
  const pool = fakePool();

  const address = await fallbackAnswer({ message: "По какому адресу вы находитесь?", pool, retrieve });
  assert.match(address.reply, /Пушкинская, 151/);

  const calories = await fallbackAnswer({ message: "Сколько калорий в тирамису?", pool, retrieve });
  assert.match(calories.reply, /420/);
  assert.match(calories.reply, /ккал/);

  const vegetarian = await fallbackAnswer({ message: "Есть ли вегетарианские блюда?", pool, retrieve });
  assert.match(vegetarian.reply, /вегетарианск/i);
});

test("fallback честно признаётся, когда не знает ответа", async () => {
  const pool = fakePool();
  const result = await fallbackAnswer({ message: "Напиши мне код на Python для сортировки массива", pool, retrieve });
  assert.equal(result.intent, "unknown");
  assert.match(result.reply, /\+7 \(495\) 123-45-67/, "должен предложить позвонить в кафе");
});

test("фраза «до 300 ккал» не превращается в ограничение по цене", async () => {
  const pool = fakePool();
  await fallbackAnswer({ message: "Есть ли блюда до 300 ккал?", pool, retrieve });

  const searchCall = pool.calls.find((call) => /FROM menu_items m[\s\S]*JOIN categories c/.test(call.sql));
  assert.ok(searchCall, "должен выполниться поиск по меню");
  assert.match(searchCall.sql, /m\.calories <= \$1/, "калорийность должна ограничиваться");
  assert.doesNotMatch(searchCall.sql, /m\.price <=/, "о цене гость не спрашивал — фильтра по цене быть не должно");
  assert.deepEqual(searchCall.params, [300, 5]);
});

test("фраза «дешевле 400 рублей» ограничивает только цену", async () => {
  const pool = fakePool();
  await fallbackAnswer({ message: "Что у вас есть дешевле 400 рублей?", pool, retrieve });

  const searchCall = pool.calls.find((call) => /FROM menu_items m[\s\S]*JOIN categories c/.test(call.sql));
  assert.ok(searchCall, "должен выполниться поиск по меню");
  assert.match(searchCall.sql, /m\.price <= \$1/, "цена должна ограничиваться");
  assert.doesNotMatch(searchCall.sql, /m\.calories <=/, "о калориях гость не спрашивал");
  assert.deepEqual(searchCall.params, [400, 5]);
});

/* ------------------------------------------------------------------ *
 *  5. Промпт
 * ------------------------------------------------------------------ */

test("системный промпт содержит правила, знания и реальное меню", () => {
  const knowledge = retrieve("адрес", { topK: 2 });
  const prompt = buildSystemPrompt({ knowledge, menu: SNAPSHOT_ROWS, context: { page: "menu.html", cart: [{ name: "Латте", quantity: 2, price: 280 }] } });

  assert.match(prompt, /Gravity Café/);
  assert.match(prompt, /ТОЛЬКО на русском языке/);
  assert.match(prompt, /не выдумывай/i);
  assert.match(prompt, /Пушкинская/, "в промпт должны попасть найденные факты (RAG)");
  assert.match(prompt, /Тирамису: 450 ₽, 420 ккал/, "в промпт попадает реальное меню из БД");
  assert.match(prompt, /Латте × 2/, "в промпт попадает контекст корзины гостя");
});

test("formatMenuSnapshot группирует меню по разделам", () => {
  const text = formatMenuSnapshot(SNAPSHOT_ROWS);
  assert.match(text, /Десерты:/);
  assert.match(text, /Напитки:/);
  assert.match(text, /Основные блюда:/);
});

/* ------------------------------------------------------------------ *
 *  6. Агент целиком (провайдер mock)
 * ------------------------------------------------------------------ */

test("runAssistant возвращает ответ, источники и не обращается к языковой модели", async () => {
  invalidateMenuCache();
  const pool = fakePool();

  const result = await runAssistant({ pool, message: "Сколько калорий в тирамису?", sessionId: "test-session" });

  assert.equal(result.provider, "mock");
  // Явно выбранный режим mock — это не деградация, а осознанный режим
  // «поиск по базе знаний без языковой модели».
  assert.equal(result.degraded, false);
  assert.match(result.reply, /420/);
  assert.ok(result.sources.length > 0, "должны вернуться источники");
  assert.ok(Array.isArray(result.toolCalls));
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.sessionId, "test-session");
});

test("runAssistant учитывает контекст страницы и корзины", async () => {
  invalidateMenuCache();
  const pool = fakePool();

  const result = await runAssistant({
    pool,
    message: "Что скажете о моём заказе?",
    context: { page: "menu.html", cart: [{ name: "Латте", quantity: 2, price: 280 }] },
  });

  assert.match(result.reply, /Латте × 2/, "ассистент должен видеть корзину гостя");
});

test("runAssistant отвергает пустое сообщение", async () => {
  const result = await runAssistant({ pool: fakePool(), message: "   " });
  assert.equal(result.error, "EMPTY_MESSAGE");
});

test("streamAssistant отдаёт события meta, delta и done", async () => {
  invalidateMenuCache();
  const pool = fakePool();
  const events = [];

  for await (const event of streamAssistant({ pool, message: "По какому адресу вы находитесь?", sessionId: "stream-test" })) {
    events.push(event);
  }

  const types = events.map((event) => event.type);
  assert.equal(types[0], "meta");
  assert.ok(types.includes("delta"));
  assert.equal(types.at(-1), "done");

  const done = events.at(-1);
  assert.match(done.reply, /Пушкинская/);
  assert.equal(done.sessionId, "stream-test");

  // Склеенный текст из delta должен совпасть с итоговым ответом.
  const streamed = events.filter((event) => event.type === "delta").map((event) => event.text).join("");
  assert.equal(streamed, done.reply);
});

test("createOpenAIProvider не обращается к сети, пока не вызван ping/chat", () => {
  const provider = createOpenAIProvider({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "test", model: "test-model", timeoutMs: 1000 });
  assert.equal(provider.name, "openai");
  assert.equal(provider.supportsTools, true);
});
