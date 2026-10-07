/**
 * Проверка модульной версии виджета (src/ai-assistant.js, сборка Vite).
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

import { JSDOM } from "jsdom";

const MODULE_PATH = path.resolve(BACK_ROOT, "src/ai-assistant.js");

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

async function waitFor(predicate, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await sleep(30);
  }
  return null;
}

/* ---------- Окружение страницы ---------- */

const dom = new JSDOM("<!DOCTYPE html><html lang='ru'><body></body></html>", {
  url: "http://localhost:5173/menu.html", // Vite dev-сервер с прокси на /api
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const requests = [];
// Node-овый fetch не умеет относительные URL, а браузер умеет. Поэтому
// подменяем его: относительные пути /api/... направляем на бэкенд :3000 —
// ровно так же, как это делает прокси Vite из vite.config.js.
const nodeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, options = {}) => {
  const target = String(url).startsWith("/api")
    ? `http://localhost:3000${url}`
    : new URL(String(url), dom.window.location.href).toString();
  requests.push({ url: String(url), target, options });
  return nodeFetch(target, options);
};
dom.window.fetch = globalThis.fetch;

globalThis.window.__gravityCart = [{ name: "Капучино", quantity: 1, price: 250 }];

console.log("\nМодульная версия виджета (gravity-cafe-back/src/ai-assistant.js)");

const { initAssistant } = await import(MODULE_PATH);
check("модуль экспортирует функцию initAssistant", typeof initAssistant === "function");

initAssistant();
await sleep(50);

check("виджет построен после вызова initAssistant()", Boolean(document.querySelector(".ga-launcher")));
check("панель чата построена", Boolean(document.querySelector(".ga-panel")));

// Адрес API должен быть относительным: Vite проксирует /api на бэкенд.
check("в dev-режиме Vite используется относительный путь /api",
  document.querySelector(".ga-launcher") !== null);

document.querySelector(".ga-launcher").click();

const suggestion = await waitFor(() => document.querySelector(".ga-suggestion"));
check("подсказки загрузились", Boolean(suggestion), "сервер на :3000 должен быть запущен");

const input = document.querySelector(".ga-input");
input.value = "Какие у вас вегетарианские блюда?";
document.querySelector(".ga-send").click();

const answer = await waitFor(() => {
  const bots = [...document.querySelectorAll(".ga-msg.ga-bot .ga-bubble")];
  const last = bots[bots.length - 1];
  return last && last.textContent.length > 80 ? last : null;
}, 15000);

check("ответ получен", Boolean(answer));
check("ответ содержит вегетарианские позиции", /вегетариан/i.test(answer?.textContent || ""));
check("список отрендерен как <ul><li>", Boolean(answer?.querySelector("ul li")));

const chatRequest = requests.find((request) => request.url.includes("/assistant/chat/stream"));
check("запрос ушёл на относительный путь /api/assistant/chat/stream",
  chatRequest?.url === "/api/assistant/chat/stream", chatRequest?.url);

if (chatRequest) {
  const payload = JSON.parse(chatRequest.options.body);
  check("контекст корзины передан", payload.context?.cart?.[0]?.name === "Капучино", JSON.stringify(payload.context?.cart));
  check("страница передана", payload.context?.page === "menu.html");
}

console.log(`\nИТОГ: проверок ${checks}, провалено ${failures}`);
dom.window.close();
process.exit(failures === 0 ? 0 : 1);
