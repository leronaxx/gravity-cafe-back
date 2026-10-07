/**
 * Инструменты (tools) ассистента — это функции, которые языковая модель
 * может вызвать сама. Это ключевая часть архитектуры: модель не «вспоминает»
 * цены и калории, а запрашивает их из базы данных PostgreSQL.
 *
 * Схема работы (function calling):
 *   1. Мы описываем инструменты в формате JSON Schema и передаём их модели.
 *   2. Модель вместо текста возвращает: {name: "search_menu", arguments: {...}}.
 *   3. Мы выполняем SQL-запрос и возвращаем результат модели.
 *   4. Модель формулирует ответ человеку уже на основе реальных данных.
 *
 * Благодаря этому ассистент не может выдумать блюдо, которого нет в меню,
 * и всегда называет актуальную цену и калорийность.
 */

const ALLERGEN_ALIASES = {
  "молоко": "молоко", "лактоза": "молоко", "молочное": "молоко", "сливки": "молоко",
  "глютен": "глютен", "мука": "глютен", "пшеница": "глютен", "хлеб": "глютен",
  "яйца": "яйца", "яйцо": "яйца",
  "орехи": "орехи", "миндаль": "орехи", "фундук": "орехи",
  "рыба": "рыба", "лосось": "рыба", "морепродукты": "рыба",
  "соя": "соя", "соевый": "соя",
};

// Категории меню в человеческих словах -> slug из базы.
const CATEGORY_ALIASES = {
  "напитки": "drinks", "напиток": "drinks", "кофе": "drinks", "drink": "drinks",
  "напитк": "drinks",
  "десерты": "desserts", "десерт": "desserts", "сладкое": "desserts", "dessert": "desserts",
  "основные": "meals", "блюда": "meals", "еда": "meals", "горячее": "meals",
  "meals": "meals", "meal": "meals",
};

export function normalizeCategory(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().trim();
  if (["drinks", "desserts", "meals"].includes(key)) return key;
  return CATEGORY_ALIASES[key] || null;
}

export function normalizeAllergen(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().trim();
  return ALLERGEN_ALIASES[key] || key;
}

/** Приводит строку КБЖУ из numeric (pg отдаёт строки) в число. */
function toNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Единый «плоский» вид блюда для модели и для фронтенда. */
export function formatMenuItem(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    price: row.price,
    prep_time: row.prep_time,
    calories: toNumber(row.calories),
    proteins: toNumber(row.proteins),
    fats: toNumber(row.fats),
    carbs: toNumber(row.carbs),
    vegetarian: Boolean(row.is_vegetarian),
    allergens: row.allergens || [],
  };
}

const MENU_SELECT = `
  SELECT
    m.id, m.name, m.description, m.price, m.prep_time,
    m.calories, m.proteins, m.fats, m.carbs, m.is_vegetarian, m.allergens,
    c.slug AS category
  FROM menu_items m
  JOIN categories c ON c.id = m.category_id
`;

/**
 * Описание инструментов для модели (формат OpenAI tools / Ollama tools).
 * Формулировки важны: именно по ним модель решает, что вызвать.
 */
export const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "search_menu",
      description:
        "Найти блюда и напитки в меню кафе. Возвращает название, цену, калорийность, БЖУ, аллергены и признак вегетарианского блюда. Используй для подбора блюд, фильтрации по калориям, цене, аллергенам и вегетарианству.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Ключевые слова: название блюда или ингредиент, например «кофе», «лосось», «шоколад».",
          },
          category: {
            type: "string",
            enum: ["drinks", "desserts", "meals"],
            description: "Раздел меню: drinks — напитки, desserts — десерты, meals — основные блюда.",
          },
          max_price: { type: "number", description: "Максимальная цена в рублях." },
          max_calories: { type: "number", description: "Максимальная калорийность порции." },
          min_proteins: { type: "number", description: "Минимальное количество белков в граммах." },
          vegetarian_only: { type: "boolean", description: "true — только вегетарианские позиции." },
          exclude_allergens: {
            type: "array",
            items: { type: "string" },
            description: "Аллергены, которых быть не должно: молоко, глютен, яйца, орехи, рыба, соя.",
          },
          sort_by: {
            type: "string",
            enum: ["price", "calories", "name", "prep_time"],
            description: "Сортировка результата.",
          },
          limit: { type: "number", description: "Сколько позиций вернуть, по умолчанию 5." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_menu_item",
      description:
        "Получить подробную информацию об одном конкретном блюде или напитке по названию: состав, цена, калорийность, БЖУ, аллергены, время приготовления.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Название блюда, например «Тирамису»." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cafe_info",
      description:
        "Получить справочную информацию о кафе: адрес, телефон, почта, часы работы, год основания, история и описание кафе.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["address", "phone", "email", "hours", "history", "about", "all"],
            description: "Что именно нужно узнать. all — всё сразу.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_cafe_knowledge",
      description:
        "Поиск по базе знаний кафе: история, концепция, зоны и столики, правила бронирования, оплата, Wi-Fi, животные, дети, музыка, работа, парковка и другие вопросы о кафе.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Вопрос или ключевые слова." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_popular_items",
      description:
        "Получить список самых популярных позиций по фактическим заказам гостей. Используй, когда просят «посоветуй что-нибудь популярное» или «что чаще всего берут».",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Сколько позиций вернуть, по умолчанию 5." },
        },
      },
    },
  },
];

/** Ограничение значений, пришедших от модели, чтобы SQL был безопасным. */
function clampLimit(value, fallback = 5, max = 20) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * Превращает аргумент модели в число или в null.
 *
 * Важный случай: языковые модели часто заполняют ВСЕ поля схемы и присылают
 * null для неиспользуемых фильтров. Нельзя проверять их через
 * Number.isFinite(Number(value)): Number(null) === 0, и тогда фильтр
 * «цена не больше 0 ₽» отсекает всё меню, а ассистент отвечает, что блюд нет.
 * Именно эта ошибка ломала ответ на вопрос «что посоветуете к кофе?».
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const SORT_COLUMNS = {
  price: "m.price ASC",
  calories: "m.calories ASC NULLS LAST",
  name: "m.name ASC",
  prep_time: "m.prep_time ASC",
};

/**
 * Выполняет инструмент по имени.
 *
 * @param {string} name — имя инструмента
 * @param {object} args — аргументы, которые вернула модель
 * @param {object} ctx — { pool, retrieve }
 */
export async function executeTool(name, args = {}, ctx) {
  const { pool, retrieve } = ctx;

  switch (name) {
    case "search_menu":
      return searchMenu(args, pool);
    case "get_menu_item":
      return getMenuItem(args, pool);
    case "get_cafe_info":
      return getCafeInfo(args, pool);
    case "search_cafe_knowledge":
      return searchKnowledge(args, retrieve);
    case "get_popular_items":
      return getPopularItems(args, pool);
    default:
      return { error: `Неизвестный инструмент: ${name}` };
  }
}

export async function searchMenu(args, pool) {
  const conditions = [];
  const params = [];

  if (args.query) {
    params.push(`%${String(args.query).toLowerCase()}%`);
    conditions.push(`(LOWER(m.name) LIKE $${params.length} OR LOWER(m.description) LIKE $${params.length})`);
  }

  const category = normalizeCategory(args.category);
  if (category) {
    params.push(category);
    conditions.push(`c.slug = $${params.length}`);
  }

  const maxPrice = toFiniteNumber(args.max_price);
  if (maxPrice !== null) {
    params.push(maxPrice);
    conditions.push(`m.price <= $${params.length}`);
  }

  const maxCalories = toFiniteNumber(args.max_calories);
  if (maxCalories !== null) {
    params.push(maxCalories);
    conditions.push(`m.calories <= $${params.length}`);
  }

  const minProteins = toFiniteNumber(args.min_proteins);
  if (minProteins !== null) {
    params.push(minProteins);
    conditions.push(`m.proteins >= $${params.length}`);
  }

  if (args.vegetarian_only === true) {
    conditions.push("m.is_vegetarian = TRUE");
  }

  // Аллергены: исключаем блюда, в составе которых есть указанный аллерген.
  const allergens = Array.isArray(args.exclude_allergens)
    ? args.exclude_allergens.map(normalizeAllergen).filter(Boolean)
    : [];
  if (allergens.length) {
    params.push(allergens);
    conditions.push(`NOT (m.allergens && $${params.length}::text[])`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = SORT_COLUMNS[args.sort_by] || "m.calories ASC NULLS LAST";
  const limit = clampLimit(args.limit, 5);

  params.push(limit);
  const { rows } = await pool.query(
    `${MENU_SELECT} ${where} ORDER BY ${order} LIMIT $${params.length}`,
    params
  );

  const result = {
    found: rows.length,
    filters: {
      query: args.query || null,
      category: category,
      max_price: args.max_price ?? null,
      max_calories: args.max_calories ?? null,
      vegetarian_only: args.vegetarian_only === true,
      exclude_allergens: allergens,
    },
    items: rows.map(formatMenuItem),
  };

  // Подсказка модели при пустом результате.
  //
  // Зачем: небольшие локальные модели иногда добавляют фильтр, о котором гость
  // не просил (например, «category: meals» на вопрос «что есть до 300 ккал»),
  // получают пустой список и делают неверный вывод «таких блюд нет». Явная
  // подсказка позволяет агенту исправиться на следующем шаге цикла.
  if (!rows.length && conditions.length > 0) {
    const narrowing = [];
    if (category) narrowing.push("category");
    if (args.query) narrowing.push("query");

    if (narrowing.length) {
      result.hint =
        `Ничего не найдено при фильтрах: ${narrowing.join(", ")}. ` +
        "Не утверждай, что таких блюд нет в меню: вызови search_menu снова без этих фильтров " +
        "(гость о них не просил) либо ответь по снимку меню из системного промпта.";
    } else {
      result.hint =
        "Ничего не найдено при заданных ограничениях (цена, калорийность, состав). " +
        "Честно скажи, что под такие ограничения позиций нет, и предложи ослабить условие.";
    }
  }

  return result;
}

/**
 * Поиск одного блюда по названию.
 * Сначала точное совпадение (без учёта регистра), потом частичное —
 * это защищает от опечаток и падежей («тирамису», «Тирамису»).
 */
export async function getMenuItem(args, pool) {
  const name = String(args.name || "").trim();
  if (!name) return { error: "Не указано название блюда" };

  const exact = await pool.query(`${MENU_SELECT} WHERE LOWER(m.name) = LOWER($1) LIMIT 1`, [name]);
  if (exact.rows.length) {
    return { item: formatMenuItem(exact.rows[0]), match: "exact" };
  }

  const partial = await pool.query(
    `${MENU_SELECT} WHERE LOWER(m.name) LIKE $1 OR LOWER($2) LIKE '%' || LOWER(m.name) || '%' LIMIT 3`,
    [`%${name.toLowerCase()}%`, name.toLowerCase()]
  );
  if (partial.rows.length) {
    return { item: formatMenuItem(partial.rows[0]), match: "partial", candidates: partial.rows.map((r) => r.name) };
  }

  return { error: `В меню нет позиции «${name}»`, item: null };
}

export async function getCafeInfo(args, pool) {
  const { rows } = await pool.query("SELECT key, value FROM cafe_settings");
  const settings = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  const info = {
    address: settings.address || null,
    phone: settings.phone || null,
    email: settings.email || null,
    hours: {
      weekday: settings.hours_weekday || null,
      weekend: settings.hours_weekend || null,
    },
    founded_year: settings.founded_year || null,
    about: settings.about_text || null,
  };

  const topic = args.topic || "all";
  if (topic === "all") return info;

  const map = {
    address: { address: info.address },
    phone: { phone: info.phone },
    email: { email: info.email },
    hours: { hours: info.hours },
    history: { founded_year: info.founded_year, about: info.about },
    about: { about: info.about },
  };
  return map[topic] || info;
}

export function searchKnowledge(args, retrieve) {
  const query = String(args.query || "").trim();
  if (!query) return { error: "Пустой поисковый запрос" };
  const chunks = retrieve(query, { topK: 4 });
  return {
    found: chunks.length,
    chunks: chunks.map((chunk) => ({ title: chunk.title, text: chunk.text, score: chunk.score })),
  };
}

export async function getPopularItems(args, pool) {
  const limit = clampLimit(args.limit, 5);
  const { rows } = await pool.query(
    `SELECT
       m.name,
       c.slug AS category,
       m.price,
       m.calories,
       SUM(oi.quantity)::int AS ordered_count
     FROM order_items oi
     JOIN menu_items m ON m.id = oi.menu_item_id
     JOIN categories c ON c.id = m.category_id
     GROUP BY m.id, m.name, c.slug, m.price, m.calories
     ORDER BY ordered_count DESC
     LIMIT $1`,
    [limit]
  );

  if (!rows.length) {
    // Заказов ещё не было — отдаём фирменные позиции, чтобы ассистент
    // всё равно мог что-то порекомендовать.
    const fallback = await pool.query(
      `${MENU_SELECT} WHERE m.name IN ('Раф кофе', 'Матча латте', 'Тирамису', 'Паста Карбонара') LIMIT $1`,
      [limit]
    );
    return {
      based_on_orders: false,
      note: "Статистики заказов пока нет, показаны фирменные позиции",
      items: fallback.rows.map(formatMenuItem),
    };
  }

  return { based_on_orders: true, items: rows };
}

/**
 * Компактная выжимка меню для системного промпта.
 *
 * Зачем: даже если модель не вызовет инструмент, у неё перед глазами будет
 * реальный список позиций с ценами и калориями. Это резко снижает
 * «галлюцинации» (выдуманные блюда) — важный пункт для защиты.
 */
export async function buildMenuSnapshot(pool) {
  const { rows } = await pool.query(
    `SELECT m.name, m.price, m.calories, m.prep_time, m.is_vegetarian, c.slug AS category
     FROM menu_items m JOIN categories c ON c.id = m.category_id
     ORDER BY c.slug, m.id`
  );
  return rows.map((row) => ({
    name: row.name,
    category: row.category,
    price: row.price,
    kcal: toNumber(row.calories),
    min: row.prep_time,
    veg: row.is_vegetarian,
  }));
}

export default { TOOL_SPECS, executeTool, buildMenuSnapshot, formatMenuItem };
