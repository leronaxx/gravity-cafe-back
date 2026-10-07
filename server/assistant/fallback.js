/**
 * Детерминированный фолбэк («ассистент без языковой модели»).
 *
 * Зачем он нужен:
 *   1. Отказоустойчивость. Если Ollama не запущена или облачный API вернул
 *      ошибку, сайт всё равно отвечает на вопросы — по базе знаний и по данным
 *      из PostgreSQL. Это называется graceful degradation.
 *   2. Честность. Фолбэк не «фантазирует»: он либо находит факт, либо
 *      говорит, что не знает, и предлагает позвонить в кафе.
 *   3. Экономия. Простые вопросы («какой адрес?», «сколько калорий в латте?»)
 *      решаются мгновенно, без обращения к модели и без затрат на токены.
 *
 * Это не «заглушка», а полноценный поисковый режим: он использует тот же
 * ретривер (RAG) и те же инструменты к базе данных, что и языковая модель.
 */

import { executeTool } from "./tools.js";

// В русском языке \b (граница слова) не работает: кириллица для регулярных
// выражений JavaScript — не «словесные» символы. Поэтому конец слова
// проверяем явным просмотром вперёд: (?!буква).
const EOW = "(?![а-яёa-z0-9])";

// Намерения (интенты) и слова-маркеры для них.
const INTENTS = [
  { id: "greeting", patterns: [new RegExp(`^(привет|здравствуй|здравствуйте|добрый (день|вечер|утро)|хай|hello|hi)${EOW}`, "i")] },
  { id: "address", patterns: [/адрес/i, /где (вы |кафе )?(находится|находитесь|расположен)/i, /как (до вас )?добрат/i, new RegExp(`где вы${EOW}`, "i"), /ваш адрес/i] },
  { id: "hours", patterns: [/час(ы|ов) работы/i, /график/i, /во сколько (вы )?(работает|открыва|закрыва)/i, /до скольки/i, /когда (вы )?открыт/i, /выходн/i, /работаете/i, /режим работы/i] },
  { id: "contacts", patterns: [/телефон/i, /позвонить/i, /контакт/i, /почт/i, /e-?mail/i, /номер/i, /связаться/i] },
  { id: "allergens", patterns: [/аллерг/i, /глютен/i, /лактоз/i, /без орех/i, /непереносимост/i] },
  { id: "vegetarian", patterns: [/вегетариан/i, /веган/i, /без мяса/i, /постн/i] },
  { id: "calories", patterns: [/калори/i, /ккал/i, /кбжу/i, /белк/i, /жир(ы|ов)/i, /углевод/i, /пищев(ая|ой) ценност/i, new RegExp(`пп${EOW}`, "i"), /похудет/i, /диет/i, /фитнес/i] },
  { id: "history", patterns: [/истори/i, /когда (вы )?(открыл|появил|основал)/i, /кто основал/i, /почему (так )?называ/i, /о кафе/i, /о вас/i, /расскаж/i, /концепц/i] },
  { id: "reservation", patterns: [/бронир/i, /бронь/i, /забронир/i, /столик/i, /зон[аыу]/i, /террас/i, /посадит/i, new RegExp(`мест[ао]${EOW}`, "i")] },
  { id: "ordering", patterns: [/предзаказ/i, /заказ/i, /корзин/i, /оформит/i, /доставк/i, /самовывоз/i, /оплат/i] },
  { id: "amenities", patterns: [/wi-?fi/i, /вайфай/i, /интернет/i, /розетк/i, /ноутбук/i, /работ(ать|а) за/i, /животн/i, /собак/i, /кошк/i, /питомц/i, /парковк/i, /дет(и|ьми|ский)/i, /коляск/i, /музык/i, /доступн/i] },
  { id: "popular", patterns: [/популярн/i, /чаще всего/i, /хит/i, /часто (берут|заказыва)/i] },
  { id: "recommend", patterns: [/посовет/i, /порекоменд/i, /что (взять|выбрать|попробовать|заказать)/i, /рекоменд/i, /помог(и|ите) (мне )?(выбрать|с выбором)/i, /вкусн/i, /хочу (кофе|десерт|поесть|перекусить)/i, /подбер/i] },
  { id: "menu_overview", patterns: [/^меню/i, /что (у вас )?есть/i, /какие (блюда|напитки|десерты|позиции)/i, /покажи меню/i] },
];

/**
 * Явное числовое ограничение: «до 300 ккал», «дешевле 400 рублей».
 * Такие фразы важнее общего вопроса про меню: гостю нужен отфильтрованный
 * список, а не обзор разделов.
 */
const NUMERIC_CONSTRAINT = /(до|дешевле|не дороже|меньше|максимум)\s*\d{2,5}/i;

/** Слова про часы работы — чтобы «работаете до 23?» не считалось ограничением цены. */
const TIME_WORDS = /(работ|час|график|открыт|закрыт)/i;

export function detectIntent(message) {
  const text = String(message || "").trim();

  if (NUMERIC_CONSTRAINT.test(text) && !TIME_WORDS.test(text)) {
    return /(ккал|калори|кбжу|белк|жир|углевод)/i.test(text) ? "calories" : "price";
  }

  for (const intent of INTENTS) {
    if (intent.patterns.some((pattern) => pattern.test(text))) return intent.id;
  }
  if (/(сколько|цена|стоит|стоимость|рубл|₽)/i.test(text)) return "price";
  return "unknown";
}

/** Достаёт из фразы число: «до 300 ккал», «дешевле 400 рублей». */
export function extractNumber(text, keywords) {
  for (const keyword of keywords) {
    const match = new RegExp(`(\\d{2,5})\\s*${keyword}`, "i").exec(text);
    if (match) return Number.parseInt(match[1], 10);
  }
  const generic = /(?:до|дешевле|не дороже|меньше|максимум)\s*(\d{2,5})/i.exec(text);
  if (generic) return Number.parseInt(generic[1], 10);
  return null;
}

function money(value) {
  return `${value} ₽`;
}

function describeItem(item) {
  const parts = [`**${item.name}** — ${money(item.price)}`];
  const facts = [];
  if (item.calories !== null && item.calories !== undefined) {
    facts.push(`${item.calories} ккал`);
    if (item.proteins !== null && item.proteins !== undefined) {
      facts.push(`Б${item.proteins} Ж${item.fats} У${item.carbs}`);
    }
  }
  if (item.prep_time) facts.push(`${item.prep_time} мин`);
  if (item.vegetarian) facts.push("вегетарианское");
  if (facts.length) parts.push(`(${facts.join(", ")})`);
  if (item.description) parts.push(`— ${item.description}`);
  return parts.join(" ");
}

function bulletList(items) {
  return items.map((item) => `• ${describeItem(item)}`).join("\n");
}

/**
 * Дописывает в ответ сведения о корзине гостя.
 * Корзину передаёт фронтенд вместе с вопросом — это делает ассистента
 * «контекстным»: он видит, что уже выбрал гость, и советует с учётом этого.
 */
export function cartNote(context) {
  const cart = context?.cart;
  if (!Array.isArray(cart) || !cart.length) return "";
  const items = cart.map((item) => `${item.name} × ${item.quantity}`).join(", ");
  const total = cart.reduce(
    (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1),
    0
  );
  return `\n\nКстати, в вашей корзине: ${items}${total ? ` (на ${total} ₽)` : ""}.`;
}

export function describeAllergens(item) {
  if (!item.allergens || !item.allergens.length) return "аллергены не указаны";
  return `аллергены: ${item.allergens.join(", ")}`;
}

/**
 * Главная функция фолбэка.
 *
 * @returns {Promise<{reply: string, sources: Array, toolCalls: Array, intent: string}>}
 */
export async function fallbackAnswer({ message, pool, retrieve, context }) {
  const text = String(message || "").trim();
  const intent = detectIntent(text);
  const toolCalls = [];
  const sources = [];

  const callTool = async (name, args) => {
    toolCalls.push({ name, arguments: args });
    return executeTool(name, args, { pool, retrieve });
  };

  const knowledge = (query, topK = 3) => {
    const chunks = retrieve(query, { topK });
    chunks.forEach((chunk) => {
      if (!sources.find((s) => s.id === chunk.id)) {
        sources.push({ id: chunk.id, title: chunk.title, topic: chunk.topic, score: chunk.score });
      }
    });
    return chunks;
  };

  // --- Приветствие ---
  if (intent === "greeting") {
    const info = await callTool("get_cafe_info", { topic: "all" });
    return {
      intent,
      sources,
      toolCalls,
      reply:
        `Здравствуйте! Я ИИ-ассистент Gravity Café. Помогу выбрать блюда и напитки, расскажу о калорийности и составе, подскажу адрес и часы работы.\n\n` +
        `📍 ${info.address}\n🕐 Будни: ${info.hours.weekday}, выходные: ${info.hours.weekend}\n\n` +
        `Спросите, например: «Что посоветуете к кофе?», «Сколько калорий в тирамису?» или «Есть ли у вас вегетарианские блюда?»`,
    };
  }

  // --- Адрес ---
  if (intent === "address") {
    const info = await callTool("get_cafe_info", { topic: "address" });
    knowledge("адрес как добраться парковка");
    return {
      intent,
      sources,
      toolCalls,
      reply:
        `Мы находимся по адресу: **${info.address}**.\n\n` +
        `Это пешеходная часть Пушкинской улицы, остановки общественного транспорта — в 3–5 минутах ходьбы. ` +
        `Собственной парковки нет, но рядом есть городская парковка вдоль улицы.`,
    };
  }

  // --- Часы работы ---
  if (intent === "hours") {
    const info = await callTool("get_cafe_info", { topic: "hours" });
    knowledge("часы работы график выходные");
    return {
      intent,
      sources,
      toolCalls,
      reply:
        `Режим работы Gravity Café:\n\n` +
        `• Понедельник — пятница: **${info.hours.weekday}**\n` +
        `• Суббота — воскресенье: **${info.hours.weekend}**\n\n` +
        `Мы работаем каждый день без выходных. Последний заказ на кухню принимаем примерно за 30 минут до закрытия.`,
    };
  }

  // --- Контакты ---
  if (intent === "contacts") {
    const info = await callTool("get_cafe_info", { topic: "all" });
    knowledge("контакты телефон почта");
    return {
      intent,
      sources,
      toolCalls,
      reply: `Наши контакты:\n\n📞 Телефон: **${info.phone}**\n✉️ Почта: **${info.email}**\n📍 Адрес: ${info.address}`,
    };
  }

  // --- Аллергены ---
  if (intent === "allergens") {
    const allergen = ["молоко", "глютен", "яйца", "орехи", "рыба", "соя"].find((a) =>
      new RegExp(a.slice(0, 4), "i").test(text)
    );
    const result = await callTool("search_menu", {
      exclude_allergens: allergen ? [allergen] : [],
      limit: 6,
    });
    knowledge("аллергены аллергия состав блюд");
    const items = result.items || [];
    return {
      intent,
      sources,
      toolCalls,
      reply:
        (allergen ? `Позиции без аллергена «${allergen}»:\n\n` : "Позиции меню и их аллергены:\n\n") +
        (items.length
          ? items.map((item) => `• **${item.name}** — ${describeAllergens(item)}`).join("\n")
          : "Не нашёл подходящих позиций.") +
        `\n\n⚠️ Важно: блюда готовятся на одной кухне, поэтому при тяжёлой форме аллергии обязательно предупредите бариста или официанта.`,
    };
  }

  // --- Вегетарианское ---
  if (intent === "vegetarian") {
    const result = await callTool("search_menu", { vegetarian_only: true, limit: 8 });
    knowledge("вегетарианские позиции без мяса");
    const items = result.items || [];
    return {
      intent,
      sources,
      toolCalls,
      reply:
        `Вегетарианские позиции в нашем меню (${items.length}):\n\n` +
        bulletList(items) +
        `\n\nВ кофейных напитках молоко можно заменить на растительное — тогда напиток станет веганским.`,
    };
  }

  // --- Калории / КБЖУ ---
  if (intent === "calories" || intent === "price") {
    // Ограничение ищем только в той величине, о которой гость и спрашивает.
    // Иначе фраза «блюда до 300 ккал» воспринималась бы ещё и как «до 300 ₽»:
    // число 300 без единицы измерения неоднозначно.
    const mentionsCalories = /(ккал|калори|кбжу|белк|жир|углевод|лёгк|легк|низкокалор)/i.test(text);
    const mentionsPrice = /(руб|₽|цен|стоит|стоимость|дешев|бюджет|дорог|недорог)/i.test(text);

    const maxCalories = mentionsCalories ? extractNumber(text, ["ккал", "калори"]) : null;
    const maxPrice = mentionsPrice ? extractNumber(text, ["руб", "₽"]) : null;
    const nameMatch = /(калори|кбжу|белк|жир|углевод|цена|стоит|стоимость)/i.test(text)
      ? text
          .replace(/(сколько|калорий|калорийность|калории|ккал|кбжу|белков|белки|жиров|жиры|углеводов|углеводы|цена|стоит|стоимость|в|у|вас|блюде|напитке|\?)/gi, " ")
          .trim()
      : "";

    if (nameMatch && nameMatch.length > 2) {
      const found = await callTool("get_menu_item", { name: nameMatch });
      if (found.item) {
        const item = found.item;
        return {
          intent,
          sources,
          toolCalls,
          reply:
            `**${item.name}** (${item.category === "drinks" ? "напитки" : item.category === "desserts" ? "десерты" : "основные блюда"})\n\n` +
            `Цена: **${money(item.price)}**\nКалорийность: **${item.calories} ккал** на порцию\n` +
            `БЖУ: белки ${item.proteins} г, жиры ${item.fats} г, углеводы ${item.carbs} г\n` +
            `Время приготовления: ${item.prep_time} мин\n${item.vegetarian ? "Вегетарианское блюдо\n" : ""}${describeAllergens(item)}\n\n` +
            `Состав: ${item.description}. Значения рассчитаны по рецептуре на одну порцию.`,
        };
      }
    }

    const args = { limit: 5 };
    if (maxCalories) args.max_calories = maxCalories;
    if (maxPrice) args.max_price = maxPrice;
    const result = await callTool("search_menu", args);
    knowledge("калорийность кбжу лёгкие блюда");
    const items = result.items || [];
    const filterText = [
      maxCalories ? `до ${maxCalories} ккал` : null,
      maxPrice ? `до ${maxPrice} ₽` : null,
    ].filter(Boolean).join(" и ");

    return {
      intent,
      sources,
      toolCalls,
      reply:
        (filterText
          ? `Вот позиции ${filterText}${maxCalories ? ", от самых лёгких" : ""}:\n\n`
          : "Самые лёгкие позиции меню:\n\n") +
        bulletList(items) +
        `\n\nНазовите конкретное блюдо — и я покажу полное КБЖУ.`,
    };
  }

  // --- История и концепция кафе ---
  if (intent === "history") {
    const info = await callTool("get_cafe_info", { topic: "history" });
    const chunks = knowledge("история кафе основание название концепция команда");
    const historyChunk = chunks.find((c) => c.topic === "history");
    return {
      intent,
      sources,
      toolCalls,
      reply:
        `${info.about || ""}\n\n` +
        (historyChunk ? `${historyChunk.text}\n\n` : "") +
        `Кафе основано в ${info.founded_year} году и находится по адресу ${info.address}.`,
    };
  }

  // --- Бронирование ---
  if (intent === "reservation") {
    const chunks = knowledge("правила бронирования зоны столики какую зону выбрать");
    const reservationChunk = chunks.find((c) => c.topic === "reservation");
    return {
      intent,
      sources,
      toolCalls,
      reply:
        `Забронировать столик можно на сайте в разделе «Бронирование»: выберите зону, столик, дату, время и число гостей (от 1 до 8).\n\n` +
        (reservationChunk ? `${reservationChunk.text}\n\n` : "") +
        `Если компания больше 8 человек или нужна помощь — позвоните нам: +7 (495) 123-45-67.`,
    };
  }

  // --- Предзаказ и оплата ---
  if (intent === "ordering") {
    const chunks = knowledge("предзаказ корзина оплата сайт как заказать");
    const orderChunk = chunks.find((c) => c.topic === "ordering") || chunks[0];
    return {
      intent,
      sources,
      toolCalls,
      reply:
        (orderChunk ? `${orderChunk.text}\n\n` : "") +
        `Оплата — наличными, картой или по QR-коду через СБП при получении заказа в кафе. Доставки у нас нет.` +
        cartNote(context),
    };
  }

  // --- Удобства ---
  if (intent === "amenities") {
    const chunks = knowledge(text, 3);
    if (chunks.length) {
      return {
        intent,
        sources,
        toolCalls,
        reply: chunks.map((chunk) => chunk.text).join("\n\n"),
      };
    }
  }

  // --- Популярное ---
  if (intent === "popular") {
    const result = await callTool("get_popular_items", { limit: 5 });
    knowledge("популярные позиции фирменные");
    const items = result.items || [];
    return {
      intent,
      sources,
      toolCalls,
      reply:
        (result.based_on_orders
          ? "По фактическим заказам гостей чаще всего берут:\n\n"
          : "Статистики заказов пока немного, поэтому покажу фирменные позиции:\n\n") +
        (result.based_on_orders
          ? items.map((item) => `• **${item.name}** — ${item.ordered_count} заказов, ${money(item.price)}`).join("\n")
          : bulletList(items)),
    };
  }

  // --- Рекомендация блюд ---
  if (intent === "recommend") {
    const wantsDrink = /кофе|напит|чай|латте|капучино|раф|матча|сок/i.test(text);
    const wantsDessert = /десерт|сладк|торт|тирамису|чизкейк|пирожн/i.test(text);
    const category = wantsDrink ? "drinks" : wantsDessert ? "desserts" : null;

    const items = [];
    if (category) {
      const result = await callTool("search_menu", { category, limit: 4, sort_by: "calories" });
      items.push(...(result.items || []));
    } else {
      const popular = await callTool("get_popular_items", { limit: 3 });
      items.push(...(popular.items || []).filter((i) => i.name));
    }
    knowledge("фирменные позиции рекомендации сочетания");
    const signature = retrieve("фирменные позиции рекомендации сочетания", { topK: 1 })[0];

    return {
      intent,
      sources,
      toolCalls,
      reply:
        `С удовольствием помогу с выбором!\n\n` +
        bulletList(items) +
        (signature ? `\n\n${signature.text}` : "") +
        `\n\nУточните, что вам ближе: кофе или чай, сладкое или сытное? И есть ли ограничения по калориям или аллергенам — подберу точнее.`,
    };
  }

  // --- Обзор меню ---
  if (intent === "menu_overview") {
    const [drinks, desserts, meals] = await Promise.all([
      callTool("search_menu", { category: "drinks", limit: 3 }),
      callTool("search_menu", { category: "desserts", limit: 3 }),
      callTool("search_menu", { category: "meals", limit: 3 }),
    ]);
    return {
      intent,
      sources,
      toolCalls,
      reply:
        `Наше меню состоит из трёх разделов.\n\n` +
        `☕ **Напитки**\n${(drinks.items || []).map((i) => `• ${i.name} — ${money(i.price)}`).join("\n")}\n\n` +
        `🍰 **Десерты**\n${(desserts.items || []).map((i) => `• ${i.name} — ${money(i.price)}`).join("\n")}\n\n` +
        `🍽️ **Основные блюда**\n${(meals.items || []).map((i) => `• ${i.name} — ${money(i.price)}`).join("\n")}\n\n` +
        `Спросите про любое блюдо — расскажу о калорийности и составе.`,
    };
  }

  // --- Неизвестный вопрос: ищем по базе знаний ---
  const chunks = knowledge(text, 3);
  const strong = chunks.filter((chunk) => chunk.score >= 0.12);

  if (strong.length) {
    return {
      intent: "knowledge",
      sources,
      toolCalls,
      reply: strong.map((chunk) => chunk.text).join("\n\n") + cartNote(context),
    };
  }

  return {
    intent: "unknown",
    sources,
    toolCalls,
    reply:
      `Не могу полностью ответить на этот вопрос. Я помогаю с меню, калорийностью и составом блюд, бронированием, ` +
      `адресом, часами работы и историей кафе.\n\n` +
      `Попробуйте спросить иначе или позвоните нам: **+7 (495) 123-45-67**.`,
  };
}

export default { fallbackAnswer, detectIntent, extractNumber };
