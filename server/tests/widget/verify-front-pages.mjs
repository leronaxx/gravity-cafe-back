/**
 * Проверка виджета на реальных HTML-страницах статичного сайта gravity-cafe-front.
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
import http from "node:http";
import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Путь от server/tests/widget до корня репозитория gravity-cafe-back
const BACK_ROOT = path.resolve(__dirname, "../../..");
// Статичный сайт лежит в соседней папке; путь можно переопределить переменной окружения.
const ROOT = process.env.GRAVITY_FRONT_DIR || path.resolve(BACK_ROOT, "../gravity-cafe-front");

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

async function waitFor(predicate, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await sleep(40);
  }
  return null;
}

/* ---------- Статический сервер над сайтом ---------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const filePath = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`\nСтатический сервер сайта: ${base}`);

/* ---------- Открываем реальные страницы ---------- */

async function openPage(page, { ask = null } = {}) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => {
    // Ошибки загрузки картинок и шрифтов не важны для проверки виджета.
    if (!/Could not load/.test(error.message)) console.log(`     [jsdom] ${error.message}`);
  });

  const dom = await JSDOM.fromURL(`${base}/${page}`, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  // jsdom не реализует fetch — отдаём node-овый и направляем /api на бэкенд.
  const nodeFetch = globalThis.fetch.bind(globalThis);
  window.fetch = async (url, options = {}) =>
    nodeFetch(String(url).startsWith("http") ? String(url) : `http://localhost:3000${url}`, options);

  await waitFor(() => window.document.querySelector(".ga-launcher"), 12000);

  if (ask) {
    window.GravityAssistant.open();
    await waitFor(() => window.document.querySelector(".ga-suggestion"), 8000);
    window.document.querySelector(".ga-input").value = ask;
    window.document.querySelector(".ga-send").click();
    const answer = await waitFor(() => {
      const bots = [...window.document.querySelectorAll(".ga-msg.ga-bot .ga-bubble")];
      const last = bots[bots.length - 1];
      return last && last.textContent.length > 60 ? last : null;
    }, 15000);
    return { dom, answer };
  }

  return { dom, answer: null };
}

console.log("\n1. Главная страница (index.html)");
const main = await openPage("index.html");
check("виджет подключён на главной странице", Boolean(main.dom.window.document.querySelector(".ga-launcher")));
check("кнопка «Подобрать блюдо с ИИ» есть в hero-блоке",
  /Подобрать блюдо с ИИ/.test(main.dom.window.document.body.textContent));
check("CSS виджета подключён",
  [...main.dom.window.document.querySelectorAll("link")].some((link) => link.href.includes("ai-assistant.css")));
check("скрипт виджета подключён",
  [...main.dom.window.document.querySelectorAll("script")].some((script) => script.src.includes("ai-assistant.js")));
check("публичный API виджета доступен", typeof main.dom.window.GravityAssistant?.ask === "function");
await sleep(200);
main.dom.window.close();

console.log("\n2. Страница меню (menu.html) — вопрос через виджет");
const menu = await openPage("menu.html", { ask: "Сколько калорий в латте?" });
check("виджет работает на странице меню", Boolean(menu.dom.window.document.querySelector(".ga-panel")));
check("меню страницы отрисовалось (скрипты сайта не сломались)",
  menu.dom.window.document.querySelectorAll("#menu-grid .menu-card").length > 0,
  `карточек: ${menu.dom.window.document.querySelectorAll("#menu-grid .menu-card").length}`);
check("ассистент ответил про латте",
  /180/.test(menu.answer?.textContent || ""), menu.answer?.textContent?.slice(0, 120));

// Проверяем связку «корзина сайта -> контекст ассистента».
const card = menu.dom.window.document.querySelector("#menu-grid .menu-card button");
card?.click();
await sleep(60);
check("корзина сайта передана виджету",
  Array.isArray(menu.dom.window.__gravityCart) && menu.dom.window.__gravityCart.length === 1,
  JSON.stringify(menu.dom.window.__gravityCart));
check("в корзине правильное блюдо",
  menu.dom.window.__gravityCart?.[0]?.quantity === 1 && Boolean(menu.dom.window.__gravityCart?.[0]?.name));
await sleep(300);
menu.dom.window.close();

console.log("\n3. Страница «О нас» (about.html)");
const about = await openPage("about.html");
check("виджет подключён на странице «О нас»", Boolean(about.dom.window.document.querySelector(".ga-launcher")));
check("страница содержит историю кафе", /Gravity/.test(about.dom.window.document.body.textContent));
await sleep(200);
about.dom.window.close();

console.log("\n4. Страница бронирования (reservation.html)");
const reservation = await openPage("reservation.html");
check("виджет подключён на странице бронирования", Boolean(reservation.dom.window.document.querySelector(".ga-launcher")));
await sleep(200);
reservation.dom.window.close();

server.close();
console.log(`\nИТОГ: проверок ${checks}, провалено ${failures}`);
process.exit(failures === 0 ? 0 : 1);
