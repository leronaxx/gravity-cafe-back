/**
 * Интеграционная проверка на РЕАЛЬНОЙ базе PostgreSQL.
 *
 * Запуск (из папки server):
 *     npm run test:db
 *
 * Чем отличается от npm test:
 *   - npm test      — юнит-тесты с заглушкой БД, работают всегда и быстро;
 *   - npm run test:db — настоящие SQL-запросы к gravity_cafe: проверяем, что
 *     инструменты ассистента действительно фильтруют меню по калориям,
 *     аллергенам и вегетарианству, а диалоги пишутся в таблицу логов.
 *
 * Переменные подключения берутся из server/.env (или из окружения):
 *     PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 */

process.env.ASSISTANT_PROVIDER = "mock";
process.env.ASSISTANT_LOGGING = "true";

import assert from "node:assert/strict";

const { default: pool } = await import("../db.js");
const { runAssistant } = await import("../assistant/agent.js");
const { executeTool } = await import("../assistant/tools.js");
const { retrieve } = await import("../assistant/retriever.js");
const { getStats } = await import("../assistant/logger.js");

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(70)}\n${title}\n${"─".repeat(70)}`);
}

/* ---------- 0. Подключение к базе ---------- */

section("0. Подключение к PostgreSQL");

try {
  const info = await pool.query("SELECT current_database() AS db, current_user AS usr");
  console.log(`  База: ${info.rows[0].db}, пользователь: ${info.rows[0].usr}`);
} catch (error) {
  console.error(`\n  Не удалось подключиться к базе: ${error.message}`);
  console.error(`  Проверьте, что PostgreSQL запущен, а в server/.env верно указаны`);
  console.error(`  PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD.`);
  console.error(`  Если базы ещё нет, выполните:`);
  console.error(`     createdb gravity_cafe`);
  console.error(`     psql -d gravity_cafe -f seed/schema.sql`);
  console.error(`     npm run seed`);
  process.exit(0);
}

const columns = await pool.query(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'menu_items'
`);
const columnNames = columns.rows.map((row) => row.column_name);
check("в таблице menu_items есть поле calories", columnNames.includes("calories"));
check("в таблице menu_items есть поле is_vegetarian", columnNames.includes("is_vegetarian"));
check("в таблице menu_items есть поле allergens", columnNames.includes("allergens"),
  "выполните: psql -d gravity_cafe -f seed/migrations/001_assistant.sql");

const { rows: menuRows } = await pool.query("SELECT COUNT(*)::int AS n FROM menu_items");
check(`в меню ${menuRows[0].n} позиций`, menuRows[0].n >= 18);

/* ---------- 1. Инструменты против реальных данных ---------- */

section("1. Инструменты ассистента и реальные SQL-запросы");

const lowCal = await executeTool("search_menu", { max_calories: 300, sort_by: "calories", limit: 10 }, { pool, retrieve });
check("фильтр «до 300 ккал» работает", lowCal.items.length > 0);
check("все позиции действительно ≤ 300 ккал",
  lowCal.items.every((item) => item.calories !== null && item.calories <= 300),
  JSON.stringify(lowCal.items.map((item) => [item.name, item.calories])));
console.log(`     найдено: ${lowCal.items.map((item) => `${item.name} (${item.calories} ккал)`).join(", ")}`);

const vegetarian = await executeTool("search_menu", { vegetarian_only: true, limit: 20 }, { pool, retrieve });
check("фильтр «только вегетарианское» работает", vegetarian.items.length > 0);
check("среди них нет блюд с мясом",
  vegetarian.items.every((item) => item.vegetarian === true) &&
    !vegetarian.items.some((item) => ["Бургер с говядиной", "Паста Карбонара", "Киш Лорен"].includes(item.name)));
console.log(`     вегетарианских позиций: ${vegetarian.items.length}`);

const noNuts = await executeTool("search_menu", { exclude_allergens: ["орехи"], limit: 20 }, { pool, retrieve });
check("фильтр «без орехов» исключает макаронс",
  !noNuts.items.some((item) => item.name === "Макаронс"),
  JSON.stringify(noNuts.items.map((item) => item.name)));
check("остальные позиции без аллергена «орехи»",
  noNuts.items.every((item) => !item.allergens.includes("орехи")));

const protein = await executeTool("search_menu", { min_proteins: 30, limit: 10 }, { pool, retrieve });
check("фильтр «много белка» (≥30 г) работает",
  protein.items.length > 0 && protein.items.every((item) => item.proteins >= 30),
  JSON.stringify(protein.items.map((item) => [item.name, item.proteins])));

const budget = await executeTool("search_menu", { max_price: 300, limit: 10 }, { pool, retrieve });
check("фильтр по цене работает", budget.items.every((item) => item.price <= 300));

const tiramisu = await executeTool("get_menu_item", { name: "Тирамису" }, { pool, retrieve });
check("карточка блюда содержит КБЖУ из базы",
  tiramisu.item.calories === 420 && tiramisu.item.proteins === 7 && tiramisu.item.fats === 26,
  JSON.stringify(tiramisu.item));

const cafeInfo = await executeTool("get_cafe_info", { topic: "all" }, { pool, retrieve });
check("адрес кафе берётся из cafe_settings", /Пушкинская/.test(cafeInfo.address || ""), cafeInfo.address);
check("телефон кафе берётся из cafe_settings", Boolean(cafeInfo.phone), cafeInfo.phone);
check("часы работы берутся из cafe_settings", Boolean(cafeInfo.hours?.weekday), JSON.stringify(cafeInfo.hours));

const knowledge = await executeTool("search_cafe_knowledge", { query: "история кафе когда открылось" }, { pool, retrieve });
check("поиск по базе знаний находит историю",
  knowledge.chunks.some((chunk) => /2025|Gravity/.test(chunk.text)));

const popular = await executeTool("get_popular_items", { limit: 5 }, { pool, retrieve });
check("популярные позиции отдаются (по заказам или как фирменные)", popular.items.length > 0);

/* ---------- 2. Диалог целиком ---------- */

section("2. Диалог с ассистентом на реальных данных (провайдер mock)");

const QUESTIONS = [
  "Привет!",
  "По какому адресу вы находитесь?",
  "До скольки вы работаете в выходные?",
  "Сколько калорий в тирамису?",
  "Покажи блюда до 300 ккал",
  "Какие у вас вегетарианские блюда?",
  "У меня аллергия на орехи, что можно взять?",
  "Что посоветуете к кофе?",
  "Расскажите историю вашего кафе",
  "Как забронировать столик на террасе?",
  "Напиши мне код на Python для сортировки массива",
];

const answers = [];
for (const question of QUESTIONS) {
  const result = await runAssistant({ pool, message: question, sessionId: "e2e-session" });
  answers.push({ question, ...result });
  const tools = result.toolCalls.map((call) => call.name).join(", ") || "—";
  console.log(`\n  Вопрос: ${question}`);
  console.log(`  Ответ:  ${result.reply.replace(/\n/g, "\n          ").slice(0, 400)}`);
  console.log(`  Инструменты: ${tools}`);
  console.log(`  Источники: ${result.sources.map((source) => source.title).join("; ") || "—"}`);
  console.log(`  Задержка: ${result.latencyMs} мс`);
}

section("3. Проверка качества ответов");

const byQuestion = Object.fromEntries(answers.map((answer) => [answer.question, answer]));

check("приветствие содержит адрес и часы работы",
  /Пушкинская/.test(byQuestion["Привет!"].reply) && /08:00/.test(byQuestion["Привет!"].reply));

check("адрес указан верно",
  /Пушкинская, 151/.test(byQuestion["По какому адресу вы находитесь?"].reply));

check("часы работы выходных указаны верно",
  /09:00/.test(byQuestion["До скольки вы работаете в выходные?"].reply));

check("калорийность тирамису — 420 ккал",
  /420/.test(byQuestion["Сколько калорий в тирамису?"].reply));

const lowCalAnswer = byQuestion["Покажи блюда до 300 ккал"].reply;
check("подбор до 300 ккал не предлагает калорийные блюда",
  !/Бургер|Карбонара/.test(lowCalAnswer), lowCalAnswer.slice(0, 200));

check("вегетарианский ответ не содержит мясных блюд",
  !/Бургер|Карбонара|Киш Лорен|Цезарь/.test(byQuestion["Какие у вас вегетарианские блюда?"].reply));

check("ответ про аллергию предупреждает про общую кухню",
  /общей кухне|одной кухне|предупредите/i.test(byQuestion["У меня аллергия на орехи, что можно взять?"].reply));

check("история кафе упоминает 2025 год",
  /2025/.test(byQuestion["Расскажите историю вашего кафе"].reply));

check("на вопрос о бронировании дана инструкция",
  /Бронирование|бронь|забронир/i.test(byQuestion["Как забронировать столик на террасе?"].reply));

check("на посторонний вопрос ассистент вежливо отказывается",
  /не могу|Попробуйте|позвоните/i.test(byQuestion["Напиши мне код на Python для сортировки массива"].reply) &&
    !/def |print\(/.test(byQuestion["Напиши мне код на Python для сортировки массива"].reply));
console.log(`\n  Ответ на посторонний вопрос:\n  ${byQuestion["Напиши мне код на Python для сортировки массива"].reply.replace(/\n/g, "\n  ")}`);

/* ---------- 4. Логирование и статистика ---------- */

section("4. Логирование диалогов и статистика");

const { rows: logged } = await pool.query(
  "SELECT COUNT(*)::int AS n FROM assistant_messages WHERE session_id = 'e2e-session'"
);
check(`диалог записан в assistant_messages (${logged[0].n} сообщений)`, logged[0].n >= QUESTIONS.length * 2);

const { rows: sample } = await pool.query(
  `SELECT role, provider, latency_ms, tool_calls
   FROM assistant_messages WHERE session_id = 'e2e-session'
   ORDER BY id DESC LIMIT 2`
);
check("в логе сохранён провайдер ответа", sample[0].provider === "mock", sample[0].provider);
check("в логе сохранены вызванные инструменты", Array.isArray(sample[0].tool_calls));

const stats = await getStats(pool, { days: 1 });
console.log(`\n  Статистика за сутки:`);
console.log(`     вопросов: ${stats.questions}, ответов: ${stats.answers}`);
console.log(`     средняя задержка: ${stats.avg_latency_ms?.toFixed(1)} мс, p95: ${stats.p95_latency_ms} мс`);
console.log(`     доля ответов без языковой модели: ${(stats.degraded_share * 100).toFixed(0)}%`);
console.log(`     вызовы инструментов: ${stats.tools.map((tool) => `${tool.name} × ${tool.calls}`).join(", ") || "—"}`);
console.log(`     популярные темы базы знаний: ${stats.top_knowledge_topics.map((topic) => topic.title).join("; ") || "—"}`);

check("статистика считает вопросы", stats.questions > 0);
check("статистика считает среднюю задержку", stats.avg_latency_ms !== null);
check("статистика видит вызовы инструментов", stats.tools.length > 0);

/* ---------- Итог ---------- */

section("ИТОГ");
console.log(`  Проверок выполнено: ${checks}, провалено: ${failures}`);

await pool.end();
process.exit(failures === 0 ? 0 : 1);
