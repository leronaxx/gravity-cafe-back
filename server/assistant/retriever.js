import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ретривер — поисковик по базе знаний (RAG, шаг Retrieval).
 *
 * Как это работает, простыми словами:
 *   1. База знаний — это список фактов (chunks). Каждый факт = один абзац текста.
 *   2. Мы считаем «вес» каждого слова в каждом факте. Редкое слово (например,
 *      «аллерген») весит больше, чем частое («кафе»). Это TF-IDF.
 *   3. Вопрос пользователя превращаем в такой же вектор весов.
 *   4. Считаем косинусную близость между вопросом и каждым фактом.
 *   5. Берём top-K самых близких фактов и отдаём их языковой модели как контекст.
 *
 * Почему лексический поиск, а не векторные эмбеддинги:
 *   - не нужны ни внешние API, ни дополнительные модели, ни GPU;
 *   - работает офлайн и мгновенно (на 36 фактах — доли миллисекунды);
 *   - результат детерминированный, что удобно для тестов и для объяснения на защите.
 * Эмбеддинги можно добавить позже как второй канал поиска (гибридный поиск):
 * для этого достаточно вернуть их из провайдера и усреднить две оценки близости.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Частые слова, которые не несут смысла при поиске.
const STOP_WORDS = new Set([
  "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то",
  "все", "она", "так", "его", "но", "да", "ты", "к", "у", "же", "вы", "за",
  "бы", "по", "только", "ее", "мне", "было", "вот", "от", "меня", "еще",
  "нет", "о", "из", "ему", "теперь", "когда", "даже", "ну", "вдруг", "ли",
  "если", "уже", "или", "ни", "быть", "был", "него", "до", "вас", "нибудь",
  "опять", "уж", "вам", "ведь", "там", "потом", "себя", "ничего", "ей",
  "может", "они", "тут", "где", "есть", "надо", "ней", "для", "мы", "тебя",
  "их", "чем", "была", "сам", "чтоб", "без", "будто", "чего", "раз", "тоже",
  "себе", "под", "будет", "ж", "тогда", "кто", "этот", "того", "потому",
  "этого", "какой", "совсем", "ним", "здесь", "этом", "один", "почти",
  "мой", "тем", "чтобы", "нее", "сейчас", "были", "куда", "зачем", "всех",
  "никогда", "можно", "при", "наконец", "два", "об", "другой", "хоть",
  "после", "над", "больше", "тот", "через", "эти", "нас", "про", "всего",
  "них", "какая", "много", "разве", "три", "эту", "моя", "впрочем", "хорошо",
  "свою", "этой", "перед", "иногда", "лучше", "чуть", "том", "нельзя",
  "такой", "им", "более", "всегда", "конечно", "всю", "между",
]);

// Русские окончания — «лёгкий стемминг». Мы не подключаем полноценный
// стеммер (например, Porter/Snowball), а отрезаем самые частые окончания,
// чтобы «калорийность» и «калорийности» давали одно и то же слово.
const ENDINGS = [
  "иями", "ями", "ами", "ыми", "ими", "ого", "его", "ому", "ему", "ыми",
  "ей", "ой", "ый", "ий", "ая", "яя", "ое", "ее", "ые", "ие", "ов", "ев",
  "ах", "ях", "ам", "ям", "ом", "ем", "ую", "юю", "ся", "у", "ю", "а", "я",
  "ы", "и", "е", "о", "ь",
];

/**
 * Приводит слово к «нормальному виду»: нижний регистр, ё -> е,
 * отрезание окончания. Служебные слова отбрасываются.
 */
export function normalizeToken(raw) {
  let token = String(raw || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\-]/g, "");

  if (!token || token.length < 3) return "";
  if (STOP_WORDS.has(token)) return "";

  // Окончание отрезаем только если остаётся осмысленный корень (>= 3 букв).
  // Порог 4 подобран так, чтобы «цены» и «цена», «калорийность» и
  // «калорийности» давали одну и ту же основу, но короткие слова не ломались.
  if (token.length >= 4) {
    for (const ending of ENDINGS) {
      if (token.length - ending.length >= 3 && token.endsWith(ending)) {
        token = token.slice(0, -ending.length);
        break;
      }
    }
  }

  return token;
}

/** Разбивает текст на нормализованные слова. */
export function tokenize(text) {
  return String(text || "")
    .split(/[^0-9a-zA-Zа-яА-ЯёЁ\-]+/)
    .map(normalizeToken)
    .filter(Boolean);
}

/** Собирает «документ» из chunk'а: заголовок, теги и текст. */
function chunkToSearchText(chunk) {
  return [chunk.title, (chunk.tags || []).join(" "), chunk.text].join(" ");
}

/**
 * Строит индекс TF-IDF по массиву фактов.
 * Возвращает структуру, которую дальше использует search().
 */
export function buildIndex(chunks) {
  const documents = chunks.map((chunk) => {
    const tokens = tokenize(chunkToSearchText(chunk));
    const termFrequency = new Map();
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) || 0) + 1);
    }
    // Нормируем частоты на длину документа, иначе длинные факты всегда выигрывают.
    const length = Math.max(tokens.length, 1);
    const weights = new Map();
    for (const [token, count] of termFrequency) {
      // 1 + log(tf) — сглаживание, чтобы редкие в тексте слова не пропадали.
      weights.set(token, 1 + Math.log(count));
    }
    return { chunk, weights, length };
  });

  // documentFrequency — в скольких фактах встречается слово.
  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const token of doc.weights.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const total = documents.length || 1;
  for (const doc of documents) {
    for (const [token, weight] of doc.weights) {
      const df = documentFrequency.get(token) || 1;
      // Классический IDF: чем реже слово во всей базе, тем оно важнее.
      const idf = Math.log((total + 1) / (df + 0.5)) + 1;
      doc.weights.set(token, weight * idf);
    }
    // Нормализуем вектор документа (для косинусной близости).
    let norm = 0;
    for (const weight of doc.weights.values()) norm += weight * weight;
    norm = Math.sqrt(norm) || 1;
    for (const [token, weight] of doc.weights) {
      doc.weights.set(token, weight / norm);
    }
  }

  return { documents, documentFrequency, total, idf: (token) => {
    const df = documentFrequency.get(token) || 0;
    return Math.log((total + 1) / (df + 0.5)) + 1;
  } };
}

/**
 * Ищет самые близкие к запросу факты.
 *
 * @param {string} query — вопрос пользователя
 * @param {object} index — результат buildIndex()
 * @param {object} [options]
 * @param {number} [options.topK=4] — сколько фактов вернуть
 * @param {number} [options.minScore=0.05] — порог отсечения нерелевантного
 * @returns {Array<{chunk: object, score: number}>}
 */
export function search(query, index, options = {}) {
  const { topK = 4, minScore = 0.05, topic = null } = options;

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  // Вектор запроса по той же схеме, что и документы.
  const queryWeights = new Map();
  for (const token of queryTokens) {
    queryWeights.set(token, (queryWeights.get(token) || 0) + 1);
  }
  let queryNorm = 0;
  for (const [token, count] of queryWeights) {
    const weight = (1 + Math.log(count)) * index.idf(token);
    queryWeights.set(token, weight);
    queryNorm += weight * weight;
  }
  queryNorm = Math.sqrt(queryNorm) || 1;

  const scored = index.documents.map((doc) => {
    let dot = 0;
    for (const [token, weight] of queryWeights) {
      const docWeight = doc.weights.get(token);
      if (docWeight) dot += (weight / queryNorm) * docWeight;
    }
    // Небольшой бонус, если совпала тема факта — повышает точность
    // на коротких запросах вроде «адрес» или «вегетарианское».
    const topicBonus = topic && doc.chunk.topic === topic ? 0.15 : 0;
    return { chunk: doc.chunk, score: dot + topicBonus };
  });

  return scored
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

let cachedIndex = null;
let cachedChunks = null;

/** Загружает базу знаний с диска (с кэшированием). */
export function loadKnowledgeBase() {
  if (cachedChunks) return cachedChunks;
  const file = path.join(__dirname, "knowledge-base.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  cachedChunks = data.chunks || [];
  return cachedChunks;
}

/** Готовый индекс базы знаний (строится один раз при старте). */
export function getKnowledgeIndex() {
  if (!cachedIndex) cachedIndex = buildIndex(loadKnowledgeBase());
  return cachedIndex;
}

/**
 * Удобная обёртка: найти факты по вопросу.
 * Возвращает не только текст, но и метаданные — их мы показываем
 * пользователю как «источники» ответа.
 */
export function retrieve(query, options = {}) {
  const index = getKnowledgeIndex();
  const found = search(query, index, options);
  return found.map(({ chunk, score }) => ({
    id: chunk.id,
    topic: chunk.topic,
    title: chunk.title,
    text: chunk.text,
    score: Number(score.toFixed(3)),
  }));
}

export default { retrieve, buildIndex, search, tokenize, normalizeToken, getKnowledgeIndex };
