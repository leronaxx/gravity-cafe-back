-- ============================================================
--  Миграция 001: данные для ИИ-ассистента
--  Применяется к УЖЕ существующей базе (данные не теряются).
--
--  Запуск:
--    psql -U postgres -d gravity_cafe -f server/seed/migrations/001_assistant.sql
--
--  Что делает:
--    1. Добавляет в menu_items пищевую ценность (калории, БЖУ),
--       признак вегетарианского блюда и список аллергенов.
--    2. Заполняет эти поля для текущего меню.
--    3. Создаёт таблицы для логирования диалогов с ассистентом.
--
--  Сами факты о кафе (история, адрес, правила) лежат не в БД, а в файле
--  server/assistant/knowledge-base.json — так базу знаний удобно править
--  без миграций, а адрес/телефон/часы берутся из cafe_settings.
-- ============================================================

-- ---------- 1. Новые поля в меню ----------

ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS calories      INTEGER;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS proteins      NUMERIC(5,1);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS fats          NUMERIC(5,1);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS carbs         NUMERIC(5,1);
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_vegetarian BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS allergens     TEXT[]  NOT NULL DEFAULT '{}';

COMMENT ON COLUMN menu_items.calories      IS 'Калорийность одной порции, ккал';
COMMENT ON COLUMN menu_items.proteins      IS 'Белки, г на порцию';
COMMENT ON COLUMN menu_items.fats          IS 'Жиры, г на порцию';
COMMENT ON COLUMN menu_items.carbs         IS 'Углеводы, г на порцию';
COMMENT ON COLUMN menu_items.is_vegetarian IS 'Признак вегетарианского блюда';
COMMENT ON COLUMN menu_items.allergens     IS 'Аллергены: молоко, глютен, яйца, орехи, рыба, соя';

-- ---------- 2. Пищевая ценность текущего меню ----------

UPDATE menu_items AS m SET
  calories      = v.calories,
  proteins      = v.proteins,
  fats          = v.fats,
  carbs         = v.carbs,
  is_vegetarian = v.is_vegetarian,
  allergens     = v.allergens
FROM (VALUES
  ('Капучино',            120,  5.5,  6.0,  9.0, TRUE,  ARRAY['молоко']),
  ('Латте',               180,  8.0,  8.5, 17.0, TRUE,  ARRAY['молоко']),
  ('Эспрессо',              5,  0.3,  0.1,  0.7, TRUE,  ARRAY[]::text[]),
  ('Раф кофе',            290,  6.0, 16.0, 28.0, TRUE,  ARRAY['молоко']),
  ('Матча латте',         210,  7.0,  7.5, 28.0, TRUE,  ARRAY['молоко']),
  ('Свежевыжатый сок',    110,  1.5,  0.3, 25.0, TRUE,  ARRAY[]::text[]),
  ('Тирамису',            420,  7.0, 26.0, 38.0, TRUE,  ARRAY['молоко','глютен','яйца']),
  ('Чизкейк Нью-Йорк',    460,  8.0, 30.0, 38.0, TRUE,  ARRAY['молоко','глютен','яйца']),
  ('Шоколадный фондан',   520,  8.0, 28.0, 58.0, TRUE,  ARRAY['молоко','глютен','яйца']),
  ('Панна котта',         380,  5.0, 24.0, 34.0, TRUE,  ARRAY['молоко']),
  ('Макаронс',            240,  4.0, 12.0, 30.0, TRUE,  ARRAY['молоко','яйца','орехи']),
  ('Штрудель',            450,  5.0, 18.0, 64.0, TRUE,  ARRAY['молоко','глютен','яйца']),
  ('Круассан с лососем',  430, 20.0, 24.0, 33.0, FALSE, ARRAY['молоко','глютен','рыба']),
  ('Авокадо тост',        390, 14.0, 26.0, 26.0, TRUE,  ARRAY['глютен','яйца']),
  ('Паста Карбонара',     720, 28.0, 34.0, 68.0, FALSE, ARRAY['молоко','глютен','яйца']),
  ('Цезарь с курицей',    480, 32.0, 28.0, 22.0, FALSE, ARRAY['молоко','глютен','яйца','рыба']),
  ('Бургер с говядиной',  890, 42.0, 48.0, 70.0, FALSE, ARRAY['молоко','глютен','яйца','соя']),
  ('Киш Лорен',           540, 18.0, 34.0, 38.0, FALSE, ARRAY['молоко','глютен','яйца'])
) AS v(name, calories, proteins, fats, carbs, is_vegetarian, allergens)
WHERE m.name = v.name;

-- ---------- 3. Таблицы для логов ассистента ----------

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

CREATE INDEX IF NOT EXISTS idx_assistant_messages_session ON assistant_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_created ON assistant_messages (created_at);

CREATE TABLE IF NOT EXISTS assistant_feedback (
    id          SERIAL PRIMARY KEY,
    message_id  INTEGER REFERENCES assistant_messages(id) ON DELETE SET NULL,
    session_id  VARCHAR(64),
    rating      SMALLINT NOT NULL,
    comment     TEXT,
    created_at  TIMESTAMP DEFAULT NOW()
);

-- ---------- 4. Проверка результата ----------

-- SELECT name, price, calories, proteins, fats, carbs, is_vegetarian, allergens
-- FROM menu_items ORDER BY id;
