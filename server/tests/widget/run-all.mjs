/**
 * Запуск всех проверок чат-виджета по очереди.
 *
 * Запуск: npm run test:widget      (из папки server)
 * Перед запуском должен работать бэкенд: npm start
 *
 * Проверяются три сценария:
 *   1. verify-widget.mjs      — виджет на минимальной странице: построение,
 *                               открытие, потоковый ответ, источники, оценка,
 *                               история диалога, экранирование HTML (XSS);
 *   2. verify-vite-module.mjs — модульная версия виджета (сборка Vite);
 *   3. verify-front-pages.mjs — реальные страницы статичного сайта
 *                               gravity-cafe-front (файлы берутся из соседней
 *                               папки; путь можно задать через GRAVITY_FRONT_DIR).
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPTS = ["verify-widget.mjs", "verify-vite-module.mjs", "verify-front-pages.mjs"];

// Проверяем, что бэкенд отвечает: без него проверки виджета бессмысленны.
const healthUrl = process.env.GRAVITY_API_URL || "http://localhost:3000/api/assistant/health";
try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) });
  const data = await response.json();
  console.log(`Бэкенд доступен: провайдер «${data.provider}», фактов в базе знаний — ${data.knowledge_chunks}, блюд — ${data.menu_items}`);
  if (data.degraded) {
    console.log(`Внимание: ассистент работает без языковой модели (${data.reason}).`);
    console.log("Проверки виджета от этого не зависят — они тестируют интерфейс и обмен данными.\n");
  }
} catch (error) {
  console.error(`\nНе удалось подключиться к бэкенду (${healthUrl}): ${error.message}`);
  console.error("Запустите бэкенд в отдельном терминале:  cd server && npm start\n");
  process.exit(1);
}

// Проверяем, установлен ли jsdom.
try {
  await import("jsdom");
} catch {
  console.error("Для проверок виджета нужен пакет jsdom. Установите его командой:");
  console.error("    npm install\n");
  process.exit(1);
}

// Проверяем наличие статичного сайта (нужен только третьей проверке).
const frontDir = process.env.GRAVITY_FRONT_DIR || path.resolve(__dirname, "../../../../gravity-cafe-front");
const frontAvailable = fs.existsSync(path.join(frontDir, "index.html"));
if (!frontAvailable) {
  console.log(`Папка статичного сайта не найдена (${frontDir}).`);
  console.log("Проверка реальных страниц будет пропущена. Путь можно указать так:");
  console.log("    GRAVITY_FRONT_DIR=/путь/к/gravity-cafe-front npm run test:widget\n");
}

let failed = 0;

for (const script of SCRIPTS) {
  if (script === "verify-front-pages.mjs" && !frontAvailable) continue;

  console.log(`\n${"=".repeat(70)}\n${script}\n${"=".repeat(70)}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) failed++;
}

console.log(`\n${"=".repeat(70)}`);
if (failed) {
  console.error(`Проверок виджета с ошибкой: ${failed} из ${SCRIPTS.length}`);
} else {
  console.log("Все проверки виджета пройдены.");
}
process.exit(failed ? 1 : 0);
