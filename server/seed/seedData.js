export default async function seedData(pool, imageMap) {
  // --- Categories ---
  const categories = [
    { slug: "drinks", label: "Напитки", icon: "☕" },
    { slug: "desserts", label: "Десерты", icon: "🍰" },
    { slug: "meals", label: "Основные блюда", icon: "🍽️" },
  ];

  const catMap = {};
  for (const cat of categories) {
    const { rows } = await pool.query(
      "INSERT INTO categories (slug, label, icon) VALUES ($1, $2, $3) RETURNING id",
      [cat.slug, cat.label, cat.icon]
    );
    catMap[cat.slug] = rows[0].id;
  }
  console.log(`  categories: ${categories.length}`);

  // --- Areas ---
  const areas = [
    { slug: "indoor", name: "Внутренний зал" },
    { slug: "terrace", name: "Терраса" },
    { slug: "outdoor", name: "Открытая площадка" },
  ];

  const areaMap = {};
  for (const area of areas) {
    const { rows } = await pool.query(
      "INSERT INTO areas (slug, name) VALUES ($1, $2) RETURNING id",
      [area.slug, area.name]
    );
    areaMap[area.slug] = rows[0].id;
  }
  console.log(`  areas: ${areas.length}`);

  // --- Tables ---
  const tableAssignments = {
    indoor: [1, 2, 3, 4, 5, 6, 7, 8],
    terrace: [9, 10, 11, 12, 13, 14],
    outdoor: [15, 16, 17, 18, 19, 20],
  };

  let tableCount = 0;
  for (const [areaSlug, numbers] of Object.entries(tableAssignments)) {
    for (const num of numbers) {
      await pool.query(
        "INSERT INTO tables (number, area_id) VALUES ($1, $2)",
        [num, areaMap[areaSlug]]
      );
      tableCount++;
    }
  }
  console.log(`  tables: ${tableCount}`);

  // --- Time Slots ---
  const timeSlots = [
    "08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00",
    "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00",
  ];

  for (const slot of timeSlots) {
    await pool.query("INSERT INTO time_slots (slot_time) VALUES ($1)", [slot]);
  }
  console.log(`  time_slots: ${timeSlots.length}`);

  // --- Menu Items ---
  const menuItems = [
    { name: "Капучино", description: "Классический итальянский кофе с молочной пенкой", price: 250, category: "drinks", image: "cappuccino-coffee-cup.png", prepTime: 5 },
    { name: "Латте", description: "Нежный кофе с большим количеством молока", price: 280, category: "drinks", image: "latte-coffee-art.jpg", prepTime: 5 },
    { name: "Эспрессо", description: "Крепкий итальянский кофе", price: 200, category: "drinks", image: "espresso-coffee.jpg", prepTime: 3 },
    { name: "Раф кофе", description: "Авторский кофе со сливками и ванилью", price: 320, category: "drinks", image: "raf-coffee-cream.jpg", prepTime: 7 },
    { name: "Матча латте", description: "Японский зелёный чай с молоком", price: 350, category: "drinks", image: "matcha-latte-green.jpg", prepTime: 6 },
    { name: "Свежевыжатый сок", description: "Апельсиновый или грейпфрутовый", price: 300, category: "drinks", image: "fresh-orange-juice.png", prepTime: 5 },
    { name: "Тирамису", description: "Классический итальянский десерт с маскарпоне", price: 450, category: "desserts", image: "classic-tiramisu.png", prepTime: 5 },
    { name: "Чизкейк Нью-Йорк", description: "Нежный сырный торт с ягодным соусом", price: 480, category: "desserts", image: "new-york-cheesecake.png", prepTime: 5 },
    { name: "Шоколадный фондан", description: "Горячий шоколадный десерт с жидкой начинкой", price: 520, category: "desserts", image: "chocolate-fondant-lava-cake.jpg", prepTime: 15 },
    { name: "Панна котта", description: "Итальянский десерт с ягодами", price: 420, category: "desserts", image: "panna-cotta-berries.jpg", prepTime: 5 },
    { name: "Макаронс", description: "Французское миндальное печенье, 3 шт", price: 380, category: "desserts", image: "french-macarons-colorful.jpg", prepTime: 3 },
    { name: "Штрудель", description: "Яблочный штрудель с мороженым", price: 440, category: "desserts", image: "apple-strudel-ice-cream.jpg", prepTime: 10 },
    { name: "Круассан с лососем", description: "Свежий круассан с слабосолёным лососем и сливочным сыром", price: 550, category: "meals", image: "croissant-salmon-cream-cheese.jpg", prepTime: 10 },
    { name: "Авокадо тост", description: "Тост с авокадо, яйцом пашот и микрозеленью", price: 480, category: "meals", image: "avocado-toast-poached-egg.png", prepTime: 12 },
    { name: "Паста Карбонара", description: "Классическая итальянская паста с беконом", price: 680, category: "meals", image: "pasta-carbonara.png", prepTime: 20 },
    { name: "Цезарь с курицей", description: "Салат с курицей, пармезаном и соусом цезарь", price: 620, category: "meals", image: "caesar-salad-chicken.jpg", prepTime: 15 },
    { name: "Бургер с говядиной", description: "Сочный бургер с мраморной говядиной и картофелем фри", price: 750, category: "meals", image: "gourmet-beef-burger-fries.jpg", prepTime: 25 },
    { name: "Киш Лорен", description: "Французский открытый пирог с беконом и сыром", price: 520, category: "meals", image: "quiche-lorraine.png", prepTime: 15 },
  ];

  for (const item of menuItems) {
    const imageId = imageMap[item.image] || null;
    await pool.query(
      "INSERT INTO menu_items (name, description, price, category_id, image_id, prep_time) VALUES ($1, $2, $3, $4, $5, $6)",
      [item.name, item.description, item.price, catMap[item.category], imageId, item.prepTime]
    );
  }
  console.log(`  menu_items: ${menuItems.length}`);

  // --- Cafe Settings ---
  const settings = [
    { key: "phone", value: "+7 (495) 123-45-67" },
    { key: "email", value: "info@gravitycafe.ru" },
    { key: "address", value: "Ростов-На-Дону, ул. Пушкинская, 151" },
    { key: "hours_weekday", value: "08:00 — 23:00" },
    { key: "hours_weekend", value: "09:00 — 00:00" },
    { key: "founded_year", value: "2025" },
    {
      key: "about_text",
      value:
        "Мы искали пространство, где можно провести время с друзьями, работать или просто наслаждаться любимым напитком. Так появилось Gravity Café: тёплый свет, живая музыка и команда, которая помнит ваши любимые блюда. Мы обжариваем зёрна вместе с надёжными партнёрами, используем сезонные продукты и постоянно тестируем новые рецепты.",
    },
  ];

  for (const s of settings) {
    await pool.query(
      "INSERT INTO cafe_settings (key, value) VALUES ($1, $2)",
      [s.key, s.value]
    );
  }
  console.log(`  cafe_settings: ${settings.length}`);
}
