/**
 * Логирование диалогов и статистика.
 *
 * Зачем это нужно (и почему это сильный пункт для диплома):
 *   1. Можно показать реальные метрики работы ассистента: сколько диалогов,
 *      средняя задержка ответа, доля ответов без языковой модели, какие
 *      инструменты вызываются чаще.
 *   2. Видно, на какие вопросы ассистент не смог ответить — это основа для
 *      расширения базы знаний (классический цикл улучшения RAG-системы).
 *   3. Оценки гостей (палец вверх/вниз) позволяют считать удовлетворённость.
 *
 * Таблицы создаются автоматически при старте (CREATE TABLE IF NOT EXISTS),
 * поэтому проект работает и без ручного запуска миграций.
 */

import { assistantConfig } from "./config.js";

let schemaReady = false;

/** Логирование можно полностью отключить через .env (ASSISTANT_LOGGING=false). */
function loggingEnabled() {
  return assistantConfig.logging;
}

export async function ensureAssistantSchema(pool) {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_messages (
      id                SERIAL PRIMARY KEY,
      session_id        VARCHAR(64),
      role              VARCHAR(16) NOT NULL,
      content           TEXT NOT NULL,
      provider          VARCHAR(32),
      model             VARCHAR(64),
      latency_ms        INTEGER,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      degraded          BOOLEAN DEFAULT FALSE,
      sources           JSONB,
      tool_calls        JSONB,
      created_at        TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_assistant_messages_session
      ON assistant_messages (session_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_assistant_messages_created
      ON assistant_messages (created_at);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS assistant_feedback (
      id          SERIAL PRIMARY KEY,
      message_id  INTEGER REFERENCES assistant_messages(id) ON DELETE SET NULL,
      session_id  VARCHAR(64),
      rating      SMALLINT NOT NULL,
      comment     TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);
  schemaReady = true;
}

/**
 * Записывает пару «вопрос — ответ» в базу.
 * Ошибка логирования НИКОГДА не должна ломать ответ гостю,
 * поэтому весь блок обёрнут в try/catch.
 */
export async function logExchange({ sessionId, question, answer, payload, logger = console }) {
  if (!payload) return;
  if (!loggingEnabled()) return;
  try {
    const { default: pool } = await import("../db.js");
    await ensureAssistantSchema(pool);

    const userRow = await pool.query(
      `INSERT INTO assistant_messages (session_id, role, content)
       VALUES ($1, 'user', $2) RETURNING id`,
      [sessionId || null, String(question).slice(0, 4000)]
    );

    const assistantRow = await pool.query(
      `INSERT INTO assistant_messages
        (session_id, role, content, provider, model, latency_ms, prompt_tokens, completion_tokens, degraded, sources, tool_calls)
       VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        sessionId || null,
        String(answer).slice(0, 8000),
        payload.provider || null,
        payload.model || null,
        payload.latencyMs || null,
        payload.usage?.promptTokens ?? null,
        payload.usage?.completionTokens ?? null,
        Boolean(payload.degraded),
        JSON.stringify(payload.sources || []),
        JSON.stringify(payload.toolCalls || []),
      ]
    );

    // Оценка привязывается к последнему ответу ассистента в сессии.
    payload.messageId = assistantRow.rows[0]?.id || null;
    payload.userMessageId = userRow.rows[0]?.id || null;
  } catch (error) {
    logger.warn?.("[assistant] не удалось записать лог диалога:", error.message);
  }
}

export async function saveFeedback(pool, { messageId, sessionId, rating, comment }) {
  await ensureAssistantSchema(pool);
  const { rows } = await pool.query(
    `INSERT INTO assistant_feedback (message_id, session_id, rating, comment)
     VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [messageId || null, sessionId || null, rating, comment || null]
  );
  return rows[0];
}

/**
 * Сводная статистика для страницы аналитики и для главы диплома.
 */
export async function getStats(pool, { days = 7 } = {}) {
  await ensureAssistantSchema(pool);

  const totals = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE role = 'user')                        AS questions,
      COUNT(*) FILTER (WHERE role = 'assistant')                   AS answers,
      COUNT(DISTINCT session_id)                                   AS sessions,
      ROUND(AVG(latency_ms) FILTER (WHERE role = 'assistant'))     AS avg_latency_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE role = 'assistant')                          AS p95_latency_ms,
      COUNT(*) FILTER (WHERE role = 'assistant' AND degraded)      AS degraded_answers,
      SUM(prompt_tokens)                                           AS prompt_tokens,
      SUM(completion_tokens)                                       AS completion_tokens
    FROM assistant_messages
    WHERE created_at >= NOW() - ($1 || ' days')::interval
  `, [String(days)]);

  const byProvider = await pool.query(`
    SELECT provider, model, COUNT(*) AS answers
    FROM assistant_messages
    WHERE role = 'assistant' AND created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY provider, model
    ORDER BY answers DESC
  `, [String(days)]);

  // Какие инструменты вызывались чаще всего.
  const tools = await pool.query(`
    SELECT tool->>'name' AS name, COUNT(*) AS calls
    FROM assistant_messages,
         LATERAL jsonb_array_elements(COALESCE(tool_calls, '[]'::jsonb)) AS tool
    WHERE role = 'assistant' AND created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY calls DESC
  `, [String(days)]);

  const topTopics = await pool.query(`
    SELECT topic->>'title' AS title, COUNT(*) AS hits
    FROM assistant_messages,
         LATERAL jsonb_array_elements(COALESCE(sources, '[]'::jsonb)) AS topic
    WHERE role = 'assistant' AND created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY hits DESC
    LIMIT 10
  `, [String(days)]);

  const feedback = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE rating > 0) AS likes,
      COUNT(*) FILTER (WHERE rating < 0) AS dislikes
    FROM assistant_feedback
    WHERE created_at >= NOW() - ($1 || ' days')::interval
  `, [String(days)]);

  const daily = await pool.query(`
    SELECT DATE(created_at) AS day, COUNT(*) FILTER (WHERE role = 'user') AS questions
    FROM assistant_messages
    WHERE created_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY 1
  `, [String(days)]);

  const row = totals.rows[0] || {};
  const questions = Number(row.questions || 0);
  const answers = Number(row.answers || 0);

  return {
    period_days: days,
    questions,
    answers,
    sessions: Number(row.sessions || 0),
    avg_latency_ms: row.avg_latency_ms ? Number(row.avg_latency_ms) : null,
    p95_latency_ms: row.p95_latency_ms ? Math.round(Number(row.p95_latency_ms)) : null,
    degraded_answers: Number(row.degraded_answers || 0),
    degraded_share: answers ? Number((Number(row.degraded_answers || 0) / answers).toFixed(3)) : 0,
    prompt_tokens: Number(row.prompt_tokens || 0),
    completion_tokens: Number(row.completion_tokens || 0),
    by_provider: byProvider.rows,
    tools: tools.rows,
    top_knowledge_topics: topTopics.rows,
    feedback: {
      likes: Number(feedback.rows[0]?.likes || 0),
      dislikes: Number(feedback.rows[0]?.dislikes || 0),
    },
    daily: daily.rows,
  };
}

export default { ensureAssistantSchema, logExchange, saveFeedback, getStats };
