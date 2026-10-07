/**
 * Проверка чат-виджета в DOM-окружении (jsdom) на минимальной странице.
 *
 * Запуск: npm run test:widget      (из папки server)
 * Требуется запущенный бэкенд: npm start
 *
 * jsdom — это браузер без графического интерфейса: он позволяет выполнить
 * код виджета по-настоящему (создать DOM, нажать кнопку, прочитать ответ),
 * но без запуска настоящего браузера.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Путь от server/tests/widget до корня репозитория gravity-cafe-back
const BACK_ROOT = path.resolve(__dirname, "../../..");

import fs from "node:fs";
import { JSDOM } from "jsdom";

const WIDGET = path.resolve(BACK_ROOT, "../gravity-cafe-front/ai-assistant.js");
const source = fs.readFileSync(WIDGET, "utf8");

let failures = 0;
let checks = 0;

function check(label, condition, detail = "") {
  checks++;
  if (condition) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 8000, interval = 30 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await sleep(interval);
  }
  return null;
}

/* ---------- Поднимаем страницу меню ---------- */

const dom = new JSDOM("<!DOCTYPE html><html lang='ru'><body><div id='root'></div></body></html>", {
  url: "http://localhost:8080/menu.html",
  runScripts: "dangerously",
  pretendToBeVisual: true,
});

const { window } = dom;
// jsdom не умеет fetch — даём node-fetch и попутно запоминаем все запросы,
// чтобы потом проверить, что именно виджет отправляет на сервер.
const sentRequests = [];
window.fetch = async (url, options = {}) => {
  sentRequests.push({ url: String(url), options });
  return fetch(url, options);
};
window.TextDecoder = TextDecoder;
window.ReadableStream = ReadableStream;
window.AbortController = AbortController;

// Виджет видит корзину гостя (её выставляет scripts.js на странице меню)
window.__gravityCart = [{ name: "Латте", quantity: 2, price: 280 }];

console.log("\n1. Построение интерфейса");

// Ждём DOMContentLoaded: виджет инициализируется именно на этом событии.
const pageReady = new Promise((resolve) => {
  if (window.document.readyState === "complete") resolve();
  else window.addEventListener("load", resolve, { once: true });
});

try {
  window.eval(source);
} catch (error) {
  console.error("  ✖ виджет упал с ошибкой:", error.message);
  process.exit(1);
}

await pageReady;
await waitFor(() => window.document.querySelector(".ga-launcher"), { timeout: 3000 });

const document = window.document;
check("кнопка запуска создана", Boolean(document.querySelector(".ga-launcher")));
check("панель чата создана", Boolean(document.querySelector(".ga-panel")));
check("приветствие показано", /Грави/.test(document.querySelector(".ga-bubble")?.textContent || ""));
check("публичный API window.GravityAssistant доступен", typeof window.GravityAssistant?.ask === "function");

console.log("\n2. Открытие панели");
document.querySelector(".ga-launcher").click();
check("панель открылась по клику", document.querySelector(".ga-panel").classList.contains("ga-open"));
check("кнопка запуска скрылась", document.querySelector(".ga-launcher").classList.contains("ga-hidden"));

check("виджет запомнил состояние открытия", JSON.parse(window.localStorage.getItem("gravity.assistant.open")) === true);
check("создан идентификатор сессии", Boolean(window.localStorage.getItem("gravity.assistant.session")));

console.log("\n3. Загрузка подсказок и статуса модели с сервера");

const suggestion = await waitFor(() => document.querySelector(".ga-suggestion"));
check("подсказки загрузились с сервера", Boolean(suggestion), "проверьте, что сервер запущен на :3000");
if (suggestion) console.log(`     первая подсказка: «${suggestion.textContent}»`);

const statusText = await waitFor(() => {
  const text = document.querySelector(".ga-status span:last-child")?.textContent || "";
  return text && !text.includes("Соединяюсь") ? text : null;
});
check("статус модели получен", Boolean(statusText), "ожидался ответ /api/assistant/health");
if (statusText) console.log(`     статус в шапке чата: «${statusText}»`);

console.log("\n4. Вопрос и потоковый ответ");

const input = document.querySelector(".ga-input");
input.value = "Сколько калорий в тирамису?";
document.querySelector(".ga-send").click();

const typing = await waitFor(() => document.querySelector(".ga-typing"));
check("показан индикатор набора текста", Boolean(typing));

const answer = await waitFor(() => {
  const bots = [...document.querySelectorAll(".ga-msg.ga-bot .ga-bubble")];
  const last = bots[bots.length - 1];
  return last && last.textContent.length > 40 ? last : null;
}, { timeout: 15000 });

check("ответ получен в чат", Boolean(answer));
if (answer) console.log(`     ответ: ${answer.textContent.replace(/\s+/g, " ").slice(0, 160)}`);
check("в ответе есть калорийность 420 ккал", /420/.test(answer?.textContent || ""));
check("жирный текст отрендерен как <strong>", Boolean(answer?.querySelector("strong")));

check("вопрос гостя отображается справа", Boolean(document.querySelector(".ga-msg.ga-user .ga-bubble")));
check("текст вопроса совпадает", /тирамису/i.test(document.querySelector(".ga-msg.ga-user .ga-bubble")?.textContent || ""));

const sourceChip = await waitFor(() => document.querySelector(".ga-source-chip"));
check("показаны источники ответа", Boolean(sourceChip));
if (sourceChip) console.log(`     источник: «${sourceChip.textContent}»`);

const feedback = await waitFor(() => document.querySelector(".ga-feedback button"));
check("есть кнопки оценки ответа", Boolean(feedback));

// Проверяем, что именно уходит на сервер: адрес, вопрос, контекст и корзина.
const chatRequest = sentRequests.find((request) => request.url.includes("/assistant/chat/stream"));
check("виджет обратился к потоковому эндпоинту /assistant/chat/stream", Boolean(chatRequest),
  sentRequests.map((request) => request.url).join(", "));

if (chatRequest) {
  const payload = JSON.parse(chatRequest.options.body);
  check("в запросе есть вопрос гостя", payload.message === "Сколько калорий в тирамису?", payload.message);
  check("в запросе есть идентификатор сессии", typeof payload.sessionId === "string" && payload.sessionId.length > 0);
  check("в запросе есть страница гостя", payload.context?.page === "menu.html", JSON.stringify(payload.context));
  check("в запросе есть корзина гостя",
    payload.context?.cart?.[0]?.name === "Латте" && payload.context?.cart?.[0]?.quantity === 2,
    JSON.stringify(payload.context?.cart));
  check("в запросе есть история диалога для контекста", Array.isArray(payload.history));
  check("запрос отправлен методом POST", chatRequest.options.method === "POST");
}

console.log("\n5. История диалога сохраняется");
const savedHistory = JSON.parse(window.localStorage.getItem("gravity.assistant.history") || "[]");
check("диалог записан в localStorage", savedHistory.length >= 2, `сообщений: ${savedHistory.length}`);
check("в истории есть вопрос и ответ",
  savedHistory.some((m) => m.role === "user") && savedHistory.some((m) => m.role === "assistant"));

console.log("\n6. Защита от XSS: вредоносный текст в ответе не исполняется");

// Подменяем fetch: сервер будто бы вернул ответ с HTML и скриптом.
const malicious = `Тирамису <script>window.__hacked = true;</script> <img src=x onerror="window.__hacked = true"> **420 ккал**`;
window.fetch = async () => {
  const events = [
    { type: "meta", provider: "mock", model: "test", degraded: true, sources: [{ id: "x", title: "Тест", topic: "t", score: 0.5 }] },
    { type: "delta", text: malicious },
    { type: "done", reply: malicious, sources: [{ id: "x", title: "Тест", topic: "t", score: 0.5 }], toolCalls: [], messageId: null },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};

input.value = "тест xss";
document.querySelector(".ga-send").click();

const xssBubble = await waitFor(() => {
  const bots = [...document.querySelectorAll(".ga-msg.ga-bot .ga-bubble")];
  const last = bots[bots.length - 1];
  return last && /Тирамису/.test(last.textContent) ? last : null;
}, { timeout: 8000 });

check("вредоносный ответ отображён как текст", Boolean(xssBubble));
check("тег <script> не создан в DOM", xssBubble ? xssBubble.querySelectorAll("script").length === 0 : false);
check("тег <img> не создан в DOM", xssBubble ? xssBubble.querySelectorAll("img").length === 0 : false);
check("скрипт не выполнился", window.__hacked !== true);
check("опасный код виден как обычный текст", /<script>/.test(xssBubble?.textContent || ""));
check("разметка **жирный** всё равно работает", Boolean(xssBubble?.querySelector("strong")));

console.log("\n7. Сброс диалога");
document.querySelector(".ga-icon-btn").click();
check("лента очищена и показано приветствие",
  document.querySelectorAll(".ga-msg").length === 1 &&
  /Грави/.test(document.querySelector(".ga-bubble")?.textContent || ""));
check("история очищена", JSON.parse(window.localStorage.getItem("gravity.assistant.history") || "[]").length === 0);

console.log(`\nИТОГ: проверок ${checks}, провалено ${failures}`);
dom.window.close();
process.exit(failures === 0 ? 0 : 1);
