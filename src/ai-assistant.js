/* ============================================================
   Gravity Café — ИИ-ассистент (чат-виджет)
   ------------------------------------------------------------
   Что делает этот файл:
     1. Рисует кнопку и панель чата в правом нижнем углу.
     2. Отправляет вопрос гостя на бэкенд: POST /api/assistant/chat/stream
     3. Читает потоковый ответ (Server-Sent Events) и печатает его
        по мере генерации — как в ChatGPT.
     4. Показывает источники ответа (какие факты базы знаний использованы)
        и кнопки оценки ответа.
     5. Передаёт на сервер контекст: на какой странице гость и что у него
        в корзине.

   Файл не требует библиотек. В этом репозитории он подключён как модуль ES
   (см. src/main.js), в статичном репозитории — как обычный <script>.
   ============================================================ */


  /* ------------------------------------------------------------------ *
   *  Настройки
   * ------------------------------------------------------------------ */

  // Адрес API. Можно переопределить до подключения скрипта:
  //   <script>window.GRAVITY_API_BASE = "http://192.168.1.10:3000/api";</script>
  function resolveApiBase() {
    if (window.GRAVITY_API_BASE) return String(window.GRAVITY_API_BASE).replace(/\/$/, "");

    const { protocol, hostname, port } = window.location;

    // Сайт открыт прямо с диска (file://) — обращаемся к локальному серверу.
    if (protocol === "file:") return "http://localhost:3000/api";

    // Тот же сервер Express (:3000) или Vite с прокси (:5173) — относительный путь.
    if (port === "3000" || port === "5173") return "/api";

    // Боевой сайт на стандартном порту (80/443): фронтенд и API на одном домене.
    if (!port) return "/api";

    // Локальный статический сервер на другом порту — идём на порт бэкенда.
    if (protocol.startsWith("http")) return `${protocol}//${hostname}:3000/api`;

    return "http://localhost:3000/api";
  }

  const CONFIG = {
    apiBase: resolveApiBase(),
    title: "Грави",
    subtitle: "ИИ-ассистент Gravity Café",
    greeting:
      "Здравствуйте! 👋 Я Грави — ассистент Gravity Café.\n\nПомогу выбрать блюда и напитки, расскажу о калорийности и составе, подскажу адрес и часы работы. Спросите что угодно о нашем кафе!",
    // Сколько последних сообщений отправлять на сервер (контекст диалога).
    historyLimit: 10,
    // Показывать ли, какие инструменты вызывал ассистент (для защиты диплома).
    debug: window.GRAVITY_ASSISTANT_DEBUG === true ||
      ["localhost", "127.0.0.1"].includes(window.location.hostname),
    storageKey: "gravity.assistant",
  };

  const STORAGE = {
    session: `${CONFIG.storageKey}.session`,
    history: `${CONFIG.storageKey}.history`,
    open: `${CONFIG.storageKey}.open`,
  };

  /* ------------------------------------------------------------------ *
   *  Состояние
   * ------------------------------------------------------------------ */

  const state = {
    open: false,
    busy: false,
    history: [],        // [{role: 'user'|'assistant', content: string}]
    sessionId: null,
    suggestions: [],
    health: null,
    elements: {},
    streamedText: "",
  };

  function readStorage(key, fallback = null) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* приватный режим браузера — просто не сохраняем */
    }
  }

  function ensureSessionId() {
    let id = readStorage(STORAGE.session);
    if (!id || typeof id !== "string") {
      id = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      writeStorage(STORAGE.session, id);
    }
    state.sessionId = id;
    return id;
  }

  /* ------------------------------------------------------------------ *
   *  Безопасный вывод текста
   * ------------------------------------------------------------------ */

  /**
   * Проверяет, что страница ещё жива.
   *
   * Это нужно на случай, когда гость ушёл на другую страницу, пока ассистент
   * ещё готовил ответ. Асинхронный код продолжает выполняться, но обращаться
   * к DOM выгруженной страницы нельзя — иначе в консоли появится ошибка.
   */
  function pageAlive() {
    return typeof document !== "undefined" && document.body !== null;
  }

  /**
   * Экранирование HTML. Ответ приходит из базы знаний и от языковой модели,
   * то есть является недоверенным текстом. Без экранирования злоумышленник
   * мог бы через вопрос заставить модель вернуть <script> и выполнить его
   * в браузере другого гостя (XSS). Поэтому сначала экранируем, потом
   * применяем форматирование.
   */
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  /** Мини-разметка: **жирный**, *курсив*, `код`, списки и абзацы. */
  function renderMarkdown(text) {
    const lines = escapeHtml(text || "").split("\n");
    const blocks = [];
    let list = null;

    const flushList = () => {
      if (list) {
        blocks.push(`<ul>${list.join("")}</ul>`);
        list = null;
      }
    };

    const inline = (line) =>
      line
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[•\-*]\s+/.test(trimmed)) {
        if (!list) list = [];
        list.push(`<li>${inline(trimmed.replace(/^[•\-*]\s+/, ""))}</li>`);
        continue;
      }
      flushList();
      if (!trimmed) {
        blocks.push('<div class="ga-gap"></div>');
        continue;
      }
      blocks.push(`<p>${inline(trimmed)}</p>`);
    }
    flushList();
    return blocks.join("");
  }

  /* ------------------------------------------------------------------ *
   *  Работа с API
   * ------------------------------------------------------------------ */

  async function apiRequest(path, options = {}) {
    const response = await fetch(`${CONFIG.apiBase}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Ошибка запроса: ${response.status}`);
    }
    return response.json();
  }

  /** Контекст, который уходит на сервер вместе с вопросом. */
  function buildContext() {
    const cart = Array.isArray(window.__gravityCart) ? window.__gravityCart : [];
    return {
      page: window.location.pathname.split("/").pop() || "index.html",
      cart: cart.slice(0, 20).map((item) => ({
        name: item.name,
        quantity: item.quantity || item.qty || 1,
        price: item.price || 0,
      })),
    };
  }

  /**
   * Отправляет вопрос и читает потоковый ответ.
   * onEvent получает события: meta, delta, reset, tool, done, error.
   */
  async function streamQuestion(message, onEvent) {
    const payload = {
      message,
      sessionId: state.sessionId,
      history: state.history.slice(-CONFIG.historyLimit),
      context: buildContext(),
    };

    const response = await fetch(`${CONFIG.apiBase}/assistant/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok && response.status !== 429) {
      throw new Error(`Сервер ответил ошибкой ${response.status}`);
    }

    // Если поток не поддерживается (старый браузер или прокси) —
    // работаем по обычному JSON-запросу. Это называется graceful fallback.
    const contentType = response.headers.get("content-type") || "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      onEvent({ type: "done", ...data });
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator;
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          let event;
          try {
            event = JSON.parse(json);
          } catch {
            continue;
          }
          if (event.type === "error") throw new Error(event.error || "Ошибка ассистента");
          onEvent(event);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   *  Построение интерфейса
   * ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildWidget() {
    /* --- кнопка запуска --- */
    const launcher = el("button", "ga-launcher");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Открыть чат с ИИ-ассистентом");
    launcher.innerHTML = '<span class="ga-launcher-icon">💬</span><span>Спросить ИИ</span>';

    /* --- панель --- */
    const panel = el("section", "ga-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Чат с ИИ-ассистентом Gravity Café");

    const header = el("header", "ga-header");
    const avatar = el("div", "ga-avatar", "🤖");
    avatar.setAttribute("aria-hidden", "true");

    const titles = el("div");
    titles.appendChild(el("div", "ga-title", CONFIG.title));
    const status = el("div", "ga-status");
    const statusDot = el("span", "ga-status-dot");
    const statusText = el("span", "", "Соединяюсь…");
    status.appendChild(statusDot);
    status.appendChild(statusText);
    titles.appendChild(status);

    const actions = el("div", "ga-header-actions");
    const resetBtn = el("button", "ga-icon-btn", "↺");
    resetBtn.type = "button";
    resetBtn.title = "Начать новый диалог";
    resetBtn.setAttribute("aria-label", "Начать новый диалог");
    const closeBtn = el("button", "ga-icon-btn", "✕");
    closeBtn.type = "button";
    closeBtn.title = "Закрыть чат";
    closeBtn.setAttribute("aria-label", "Закрыть чат");
    actions.appendChild(resetBtn);
    actions.appendChild(closeBtn);

    header.appendChild(avatar);
    header.appendChild(titles);
    header.appendChild(actions);

    /* --- лента сообщений --- */
    const messages = el("div", "ga-messages");
    messages.setAttribute("aria-live", "polite");
    messages.setAttribute("role", "log");

    /* --- подсказки --- */
    const suggestions = el("div", "ga-suggestions");

    /* --- поле ввода --- */
    const inputRow = el("div", "ga-input-row");
    const input = el("textarea", "ga-input");
    input.rows = 1;
    input.placeholder = "Спросите о меню, калориях, адресе…";
    input.setAttribute("aria-label", "Ваш вопрос ассистенту");
    const send = el("button", "ga-send", "➤");
    send.type = "button";
    send.setAttribute("aria-label", "Отправить сообщение");
    inputRow.appendChild(input);
    inputRow.appendChild(send);

    const footnote = el(
      "div",
      "ga-footnote",
      "Ассистент может ошибаться. Калорийность указана справочно. Тел.: +7 (495) 123-45-67"
    );

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(suggestions);
    panel.appendChild(inputRow);
    panel.appendChild(footnote);

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    state.elements = {
      launcher, panel, messages, suggestions, input, send, statusText, statusDot, resetBtn, closeBtn,
    };

    /* --- обработчики --- */
    launcher.addEventListener("click", () => toggle(true));
    closeBtn.addEventListener("click", () => toggle(false));
    resetBtn.addEventListener("click", resetDialogue);

    send.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) toggle(false);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Сообщения
   * ------------------------------------------------------------------ */

  function addMessage(role, text) {
    if (!pageAlive()) return null;
    const wrapper = el("div", `ga-msg ${role === "user" ? "ga-user" : "ga-bot"}`);
    const bubble = el("div", "ga-bubble");
    bubble.innerHTML = renderMarkdown(text);
    wrapper.appendChild(bubble);
    state.elements.messages.appendChild(wrapper);
    scrollToBottom();
    return { wrapper, bubble };
  }

  function addSources(wrapper, sources, tools) {
    if (!pageAlive() || !wrapper) return;
    const chips = [];

    for (const source of (sources || []).slice(0, 3)) {
      const chip = el("span", "ga-source-chip", `📚 ${source.title}`);
      chip.title = `Факт из базы знаний: ${source.title} (близость ${source.score})`;
      chips.push(chip);
    }

    if (CONFIG.debug && tools && tools.length) {
      for (const tool of tools) {
        const chip = el("span", "ga-source-chip ga-tool", `🔧 ${tool.name}`);
        chip.title = `Вызов инструмента: ${tool.name}(${JSON.stringify(tool.arguments)})`;
        chips.push(chip);
      }
    }

    if (!chips.length) return;
    const row = el("div", "ga-sources");
    chips.forEach((chip) => row.appendChild(chip));
    wrapper.appendChild(row);
  }

  function addFeedback(wrapper, messageId) {
    if (!pageAlive() || !wrapper) return;
    const row = el("div", "ga-feedback");
    const up = el("button", "", "👍");
    const down = el("button", "", "👎");
    up.type = "button";
    down.type = "button";
    up.title = "Ответ полезен";
    down.title = "Ответ не помог";

    const vote = (rating, button) => {
      apiRequest("/assistant/feedback", {
        method: "POST",
        body: JSON.stringify({ messageId, sessionId: state.sessionId, rating }),
      })
        .then(() => {
          up.classList.toggle("ga-voted", rating === 1);
          down.classList.toggle("ga-voted", rating === -1);
          up.disabled = true;
          down.disabled = true;
          button.textContent = rating === 1 ? "👍 спасибо" : "👎 учтём";
        })
        .catch(() => {
          /* оценка не критична для работы чата */
        });
    };

    up.addEventListener("click", () => vote(1, up));
    down.addEventListener("click", () => vote(-1, down));

    row.appendChild(up);
    row.appendChild(down);
    wrapper.appendChild(row);
  }

  function addTyping() {
    if (!pageAlive()) return null;
    const wrapper = el("div", "ga-msg ga-bot");
    const bubble = el("div", "ga-bubble");
    const typing = el("div", "ga-typing");
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));
    bubble.appendChild(typing);
    wrapper.appendChild(bubble);
    state.elements.messages.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
  }

  function addError(text) {
    if (!pageAlive()) return;
    const box = el("div", "ga-error", text);
    state.elements.messages.appendChild(box);
    scrollToBottom();
  }

  function scrollToBottom() {
    if (!pageAlive()) return;
    const { messages } = state.elements;
    messages.scrollTop = messages.scrollHeight;
  }

  /* ------------------------------------------------------------------ *
   *  Отправка вопроса
   * ------------------------------------------------------------------ */

  async function submit() {
    const input = state.elements.input;
    const text = input.value.trim();
    if (!text || state.busy) return;

    // Ограничение длины — то же, что проверяет сервер.
    if (text.length > 1000) {
      addError("Сообщение слишком длинное. Пожалуйста, сократите вопрос.");
      return;
    }

    input.value = "";
    input.style.height = "auto";
    state.busy = true;
    state.elements.send.disabled = true;
    state.elements.suggestions.innerHTML = "";

    addMessage("user", text);
    state.history.push({ role: "user", content: text });

    const typing = addTyping();
    let message = null;
    let bubble = null;

    const ensureBubble = () => {
      if (bubble) return bubble;
      typing?.remove();
      const created = addMessage("bot", "");
      if (!created) return null;
      message = created.wrapper;
      bubble = created.bubble;
      return bubble;
    };

    try {
      await streamQuestion(text, (event) => {
        // Гость мог уйти со страницы, пока модель готовила ответ.
        if (!pageAlive()) return;

        if (event.type === "meta") {
          applyHealth({
            provider: event.provider,
            model: event.model,
            degraded: event.degraded,
            reason: event.degradedReason,
          });
          const target = ensureBubble();
          target.dataset.sources = JSON.stringify(event.sources || []);
        }

        if (event.type === "reset") {
          // Модель ушла за данными в базу — очищаем черновик.
          if (bubble) bubble.innerHTML = "";
          state.streamedText = "";
        }

        if (event.type === "tool") {
          const target = ensureBubble();
          const tools = JSON.parse(target.dataset.tools || "[]");
          tools.push({ name: event.name, arguments: event.arguments });
          target.dataset.tools = JSON.stringify(tools);
        }

        if (event.type === "delta") {
          const target = ensureBubble();
          state.streamedText += event.text;
          target.innerHTML = renderMarkdown(state.streamedText);
          scrollToBottom();
        }

        if (event.type === "done") {
          const target = ensureBubble();
          if (event.reply) {
            state.streamedText = event.reply;
            target.innerHTML = renderMarkdown(event.reply);
          }
          state.history.push({ role: "assistant", content: state.streamedText });

          const sources = event.sources && event.sources.length
            ? event.sources
            : JSON.parse(target.dataset.sources || "[]");
          const tools = event.toolCalls && event.toolCalls.length
            ? event.toolCalls
            : JSON.parse(target.dataset.tools || "[]");

          addSources(message, sources, tools);
          if (event.messageId) addFeedback(message, event.messageId);

          state.streamedText = "";
          saveHistory();
        }
      });
    } catch (error) {
      if (!pageAlive()) return;
      typing?.remove();
      addError(
        `${error.message || "Не удалось получить ответ."} Проверьте, что сервер запущен, или позвоните нам: +7 (495) 123-45-67.`
      );
    } finally {
      state.busy = false;
      if (pageAlive()) {
        state.elements.send.disabled = false;
        state.elements.input.focus();
      }
    }
  }

  function saveHistory() {
    writeStorage(STORAGE.history, state.history.slice(-CONFIG.historyLimit));
  }

  /* ------------------------------------------------------------------ *
   *  Открытие, закрытие, сброс
   * ------------------------------------------------------------------ */

  function toggle(open) {
    state.open = open;
    state.elements.panel.classList.toggle("ga-open", open);
    state.elements.launcher.classList.toggle("ga-hidden", open);
    writeStorage(STORAGE.open, open);
    if (open) {
      state.elements.input.focus();
      scrollToBottom();
      if (!state.suggestions.length) loadSuggestions();
      if (!state.health) loadHealth();
    }
  }

  function resetDialogue() {
    state.history = [];
    state.streamedText = "";
    writeStorage(STORAGE.history, []);
    writeStorage(STORAGE.session, null);
    ensureSessionId();
    state.elements.messages.innerHTML = "";
    greet();
    loadSuggestions();
  }

  function greet() {
    addMessage("bot", CONFIG.greeting);
  }

  /* ------------------------------------------------------------------ *
   *  Подсказки и статус модели
   * ------------------------------------------------------------------ */

  async function loadSuggestions() {
    try {
      const data = await apiRequest("/assistant/suggestions");
      state.suggestions = data.suggestions || [];
    } catch {
      state.suggestions = [
        "Что посоветуете к кофе?",
        "Сколько калорий в тирамису?",
        "По какому адресу вы находитесь?",
      ];
    }
    if (!pageAlive()) return;
    renderSuggestions();
  }

  function renderSuggestions() {
    if (!pageAlive()) return;
    const box = state.elements.suggestions;
    box.innerHTML = "";
    state.suggestions.slice(0, 4).forEach((text) => {
      const chip = el("button", "ga-suggestion", text);
      chip.type = "button";
      chip.addEventListener("click", () => {
        state.elements.input.value = text;
        submit();
      });
      box.appendChild(chip);
    });
  }

  async function loadHealth() {
    try {
      const info = await apiRequest("/assistant/health");
      if (pageAlive()) applyHealth(info);
    } catch {
      if (pageAlive()) applyHealth({ degraded: true, reason: "сервер недоступен" });
    }
  }

  /** Показывает гостю, как сейчас работает ассистент. */
  function applyHealth(info) {
    state.health = info;
    const { statusText, statusDot } = state.elements;
    if (!statusText) return;

    if (info.degraded) {
      statusText.textContent = "Режим базы знаний (без языковой модели)";
      statusDot.classList.add("ga-warn");
      return;
    }

    const providerNames = {
      ollama: "локальная модель",
      openai: "облачная модель",
      mock: "режим базы знаний",
    };
    const provider = providerNames[info.provider] || info.provider || "онлайн";
    statusText.textContent = `На связи · ${provider}${info.model ? ` (${info.model})` : ""}`;
    statusDot.classList.remove("ga-warn");
  }

  /* ------------------------------------------------------------------ *
   *  Запуск
   * ------------------------------------------------------------------ */

  function init() {
    if (document.querySelector(".ga-panel")) return; // защита от двойного подключения
    ensureSessionId();
    buildWidget();

    state.history = readStorage(STORAGE.history, []) || [];

    if (state.history.length) {
      // Восстанавливаем диалог после перезагрузки страницы.
      for (const message of state.history) {
        addMessage(message.role === "user" ? "user" : "bot", message.content);
      }
    } else {
      greet();
    }

    renderSuggestions();
    loadSuggestions();
    loadHealth();

    if (readStorage(STORAGE.open, false) === true) {
      // Чат был открыт до перезагрузки — открываем снова.
      state.elements.panel.classList.add("ga-open");
      state.elements.launcher.classList.add("ga-hidden");
      state.open = true;
    }

    // Публичный интерфейс: сайт может попросить ассистента открыться
    // или задать вопрос программно (например, с кнопки «Подобрать блюдо»).
    window.GravityAssistant = {
      open: () => toggle(true),
      close: () => toggle(false),
      ask: (question) => {
        toggle(true);
        state.elements.input.value = question;
        submit();
      },
      reset: resetDialogue,
      config: CONFIG,
    };
  }

  /**
   * Точка входа для сборщика Vite: вызывается из src/main.js.
   * Автозапуск здесь не нужен — модуль подключается как обычный import.
   */
  export function initAssistant() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }
