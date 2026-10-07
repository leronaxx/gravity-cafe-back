import "./styles.css";
import "./ai-assistant.css"; // оформление чат-виджета ИИ-ассистента
import { api } from "./api.js";
import { initAssistant } from "./ai-assistant.js";

function isValidPhone(phone) {
  const cleaned = phone.replace(/[\s\-\(\)]/g, "");
  return /^(\+7|8)\d{10}$/.test(cleaned);
}

// управляет шапкой и мобильным меню
function setupNav() {
  const nav = document.querySelector(".site-nav");
  const toggle = document.querySelector(".nav-toggle");
  const mobile = document.querySelector(".mobile-menu");
  const links = mobile ? mobile.querySelectorAll("a") : [];

  const onScroll = () => {
    if (!nav) return;
    nav.classList.toggle("scrolled", window.scrollY > 10);
  };

  window.addEventListener("scroll", onScroll);
  onScroll();

  toggle?.addEventListener("click", () => {
    mobile?.classList.toggle("open");
  });

  links.forEach((link) =>
    link.addEventListener("click", () => {
      mobile?.classList.remove("open");
    })
  );
}

// плавное появление элементов
function animateHeroReveal() {
  const items = Array.from(document.querySelectorAll("[data-reveal]"));
  if (!items.length) return;
  items.forEach((el, index) => {
    setTimeout(() => el.classList.add("show"), 140 * index + 100);
  });
}

// загружает настройки кафе из API и обновляет data-settings элементы
async function initSettings() {
  try {
    const settings = await api.getSettings();
    document.querySelectorAll("[data-settings]").forEach((el) => {
      const key = el.dataset.settings;
      if (settings[key]) {
        el.textContent = settings[key];
      }
    });
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
}

// авторизация: модалка, логин, регистрация
function initAuth() {
  const authOverlay = document.getElementById("auth-overlay");
  const authModal = document.getElementById("auth-modal");
  const authForm = document.getElementById("auth-form");
  const authToggle = document.getElementById("auth-toggle");
  const closeAuthBtn = document.getElementById("close-auth");
  const authTitle = document.getElementById("auth-title");
  const authSubmit = document.getElementById("auth-submit");
  const authNameField = document.getElementById("auth-name-field");
  const authName = document.getElementById("auth-name");
  const authPhone = document.getElementById("auth-phone");
  const authPassword = document.getElementById("auth-password");
  const authPhoneError = document.getElementById("auth-phone-error");
  const authError = document.getElementById("auth-error");
  const navAuthBtn = document.getElementById("nav-auth-btn");
  const navAuthBtnMobile = document.getElementById("nav-auth-btn-mobile");

  let mode = "login";

  function openAuthModal() {
    authOverlay?.classList.add("open");
    authModal?.classList.add("open");
  }

  function closeAuthModal() {
    authOverlay?.classList.remove("open");
    authModal?.classList.remove("open");
    authPhoneError && (authPhoneError.style.display = "none");
    authError && (authError.style.display = "none");
  }

  window.openAuthModal = openAuthModal;

  function updateNavAuth() {
    const user = localStorage.getItem("user");
    const parsed = user ? JSON.parse(user) : null;

    [navAuthBtn, navAuthBtnMobile].forEach((btn) => {
      if (!btn) return;
      if (parsed) {
        btn.textContent = parsed.name || parsed.phone || "Профиль";
        btn.onclick = (e) => {
          e.preventDefault();
          window.location.href = "profile.html";
        };
      } else {
        btn.textContent = "Войти";
        btn.onclick = (e) => {
          e.preventDefault();
          openAuthModal();
        };
      }
    });
  }

  authToggle?.addEventListener("click", (e) => {
    e.preventDefault();
    if (mode === "login") {
      mode = "register";
      authTitle && (authTitle.textContent = "Регистрация");
      authSubmit && (authSubmit.textContent = "Зарегистрироваться");
      authNameField && (authNameField.style.display = "block");
      authToggle.textContent = "Уже есть аккаунт? Войдите";
    } else {
      mode = "login";
      authTitle && (authTitle.textContent = "Вход");
      authSubmit && (authSubmit.textContent = "Войти");
      authNameField && (authNameField.style.display = "none");
      authToggle.textContent = "Нет аккаунта? Зарегистрируйтесь";
    }
    authPhoneError && (authPhoneError.style.display = "none");
    authError && (authError.style.display = "none");
  });

  authForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    authPhoneError && (authPhoneError.style.display = "none");
    authError && (authError.style.display = "none");

    const phone = authPhone?.value || "";
    const password = authPassword?.value || "";
    const name = authName?.value || "";

    if (!isValidPhone(phone)) {
      authPhoneError && (authPhoneError.style.display = "block");
      return;
    }

    try {
      let result;
      if (mode === "register") {
        result = await api.register({ name, phone, password });
      } else {
        result = await api.login({ phone, password });
      }
      localStorage.setItem("token", result.token);
      localStorage.setItem("user", JSON.stringify(result.user));
      closeAuthModal();
      updateNavAuth();
      // если мы на странице профиля — перезагрузим, чтобы подгрузились данные
      if (window.location.pathname.includes("profile")) {
        window.location.reload();
      }
    } catch (err) {
      if (authError) {
        authError.textContent = err.message || "Произошла ошибка";
        authError.style.display = "block";
      }
    }
  });

  closeAuthBtn?.addEventListener("click", closeAuthModal);
  authOverlay?.addEventListener("click", closeAuthModal);

  updateNavAuth();

  // проверяем токен при загрузке
  const token = localStorage.getItem("token");
  if (token) {
    api.getMe().then((res) => {
      const u = res?.user || res;
      localStorage.setItem("user", JSON.stringify(u));
      updateNavAuth();
    }).catch(() => {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      updateNavAuth();
    });
  }
}

// страница профиля: данные пользователя, заказы, брони, выход
async function initProfilePage() {
  const profileContent = document.getElementById("profile-content");
  const notAuth = document.getElementById("profile-not-auth");
  if (!profileContent || !notAuth) return;

  const token = localStorage.getItem("token");
  const savedUser = localStorage.getItem("user");

  if (!token || !savedUser) {
    notAuth.style.display = "block";
    profileContent.style.display = "none";
    document.getElementById("profile-login-btn")?.addEventListener("click", () => {
      window.openAuthModal && window.openAuthModal();
    });
    return;
  }

  let user;
  try {
    user = JSON.parse(savedUser);
  } catch (_) {
    notAuth.style.display = "block";
    return;
  }

  profileContent.style.display = "block";
  notAuth.style.display = "none";

  const greeting = document.getElementById("profile-greeting");
  if (greeting) greeting.textContent = `Привет, ${user.name}!`;

  const nameEl = document.getElementById("profile-name");
  const phoneEl = document.getElementById("profile-phone");
  if (nameEl) nameEl.textContent = user.name;
  if (phoneEl) phoneEl.textContent = user.phone;

  document.getElementById("logout-btn")?.addEventListener("click", () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.href = "index.html";
  });

  // форматирует дату в российский формат
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString("ru-RU");
  }

  function fmtTime(t) {
    return t ? String(t).substring(0, 5) : "";
  }

  // загружаем заказы
  const ordersList = document.getElementById("profile-orders");
  const ordersEmpty = document.getElementById("profile-orders-empty");
  try {
    const orders = await api.getMyOrders();
    if (!orders.length) {
      ordersEmpty.style.display = "block";
    } else {
      orders.forEach((order) => {
        const card = document.createElement("div");
        card.className = "card";

        const title = document.createElement("h4");
        title.textContent = `Заказ №${order.id}`;
        const pill = document.createElement("span");
        pill.className = "status-pill";
        pill.textContent = order.status;
        title.appendChild(pill);

        const info = document.createElement("p");
        info.className = "muted small";
        info.textContent = `${fmtDate(order.order_date)} в ${fmtTime(order.order_time)} · ${order.area_name}, столик ${order.table_number} · готовность в ${fmtTime(order.ready_time)}`;

        const total = document.createElement("div");
        total.className = "price";
        total.textContent = `${order.total} ₽`;

        card.appendChild(title);
        card.appendChild(info);
        card.appendChild(total);

        if (order.items?.length) {
          const itemsDiv = document.createElement("div");
          itemsDiv.className = "order-items";
          order.items.forEach((item) => {
            const row = document.createElement("div");
            row.className = "order-items-row";
            const name = document.createElement("span");
            name.textContent = `${item.menu_item_name} × ${item.quantity}`;
            const price = document.createElement("span");
            price.className = "muted";
            price.textContent = `${item.unit_price * item.quantity} ₽`;
            row.appendChild(name);
            row.appendChild(price);
            itemsDiv.appendChild(row);
          });
          card.appendChild(itemsDiv);
        }

        ordersList.appendChild(card);
      });
    }
  } catch (err) {
    ordersList.innerHTML = `<div class="error-banner">Не удалось загрузить заказы: ${err.message}</div>`;
  }

  // загружаем брони
  const reservationsList = document.getElementById("profile-reservations");
  const reservationsEmpty = document.getElementById("profile-reservations-empty");
  try {
    const reservations = await api.getMyReservations();
    if (!reservations.length) {
      reservationsEmpty.style.display = "block";
    } else {
      reservations.forEach((r) => {
        const card = document.createElement("div");
        card.className = "card";

        const title = document.createElement("h4");
        title.textContent = `Бронь №${r.id}`;
        const pill = document.createElement("span");
        pill.className = "status-pill";
        pill.textContent = r.status;
        title.appendChild(pill);

        const info = document.createElement("p");
        info.className = "muted small";
        info.textContent = `${fmtDate(r.reservation_date)} в ${fmtTime(r.reservation_time)} · ${r.area_name}, столик ${r.table_number} · ${r.guests} гостей`;

        card.appendChild(title);
        card.appendChild(info);
        reservationsList.appendChild(card);
      });
    }
  } catch (err) {
    reservationsList.innerHTML = `<div class="error-banner">Не удалось загрузить бронирования: ${err.message}</div>`;
  }
}

// строит меню, корзину и форму предзаказа
async function initMenuPage() {
  const grid = document.getElementById("menu-grid");
  const tabContainer = document.getElementById("menu-tabs");
  if (!grid || !tabContainer) return;

  // скелетон загрузки
  grid.innerHTML = Array(6)
    .fill('<div class="skeleton skeleton-card"></div>')
    .join("");

  let menuItems, categories, timeSlots, areas;
  try {
    [menuItems, categories, timeSlots, areas] = await Promise.all([
      api.getMenu(),
      api.getCategories(),
      api.getTimeSlots(),
      api.getAreas(),
    ]);
  } catch (err) {
    grid.innerHTML =
      '<div class="error-banner"><p>Не удалось загрузить меню.</p><button class="btn" onclick="location.reload()">Обновить</button></div>';
    return;
  }

  const state = { active: categories[0]?.slug || "drinks", cart: [], maxPrep: 0 };

  const cartOverlay = document.getElementById("cart-overlay");
  const cartPanel = document.getElementById("cart-panel");
  const cartCount = document.getElementById("cart-count");
  const cartItems = document.getElementById("cart-items");
  const cartEmpty = document.getElementById("cart-empty");
  const prepTime = document.getElementById("prep-time");
  const cartTotal = document.getElementById("cart-total");
  const openCartBtn = document.getElementById("open-cart");
  const closeCartBtn = document.getElementById("close-cart");
  const orderForm = document.getElementById("order-form");
  const orderDate = document.getElementById("order-date");
  const orderTime = document.getElementById("order-time");
  const orderArea = document.getElementById("order-area");
  const orderTable = document.getElementById("order-table");
  const confirmation = document.getElementById("order-confirmation");
  const newOrderBtn = document.getElementById("new-order");
  const closeConfirmBtn = document.getElementById("close-confirmation");
  const orderSaveBtn = document.getElementById("order-save");
  const orderSaveNote = document.getElementById("order-save-note");

  if (orderDate) {
    orderDate.min = new Date().toISOString().split("T")[0];
  }

  timeSlots.forEach((slot) => {
    const option = document.createElement("option");
    option.value = slot;
    option.textContent = slot;
    orderTime?.appendChild(option);
  });

  areas.forEach((area) => {
    const option = document.createElement("option");
    option.value = area.slug;
    option.textContent = area.name;
    orderArea?.appendChild(option);
  });

  function renderTabs() {
    tabContainer.innerHTML = "";
    categories.forEach((cat) => {
      const btn = document.createElement("button");
      btn.className = `tab-button ${state.active === cat.slug ? "active" : ""}`;
      btn.textContent = `${cat.icon} ${cat.label}`;
      btn.addEventListener("click", () => {
        state.active = cat.slug;
        renderTabs();
        renderMenu();
      });
      tabContainer.appendChild(btn);
    });
  }

  function renderMenu() {
    grid.innerHTML = "";
    menuItems
      .filter((item) => item.category === state.active)
      .forEach((item) => {
        const card = document.createElement("article");
        card.className = "card menu-card";

        const img = document.createElement("img");
        img.src = item.image_url || "";
        img.alt = item.name;

        const body = document.createElement("div");
        body.className = "menu-body";

        const badge = document.createElement("div");
        badge.className = "badge";
        badge.textContent = `${item.prep_time} мин`;

        const h3 = document.createElement("h3");
        h3.textContent = item.name;

        const desc = document.createElement("p");
        desc.className = "muted";
        desc.textContent = item.description;

        const meta = document.createElement("div");
        meta.className = "menu-meta";

        const price = document.createElement("div");
        price.className = "price";
        price.textContent = `${item.price} ₽`;

        const addBtn = document.createElement("button");
        addBtn.className = "btn btn-primary";
        addBtn.textContent = "Добавить";
        addBtn.addEventListener("click", () => addToCart(item.id));

        meta.appendChild(price);
        meta.appendChild(addBtn);
        body.appendChild(badge);
        body.appendChild(h3);
        body.appendChild(desc);
        body.appendChild(meta);
        card.appendChild(img);
        card.appendChild(body);
        grid.appendChild(card);
      });
  }

  function updateCart() {
    const totalItems = state.cart.reduce((sum, entry) => sum + entry.qty, 0);
    cartCount.textContent = String(totalItems);
    cartItems.innerHTML = "";

    if (!state.cart.length) {
      cartEmpty.style.display = "block";
      prepTime.textContent = "0 минут";
      cartTotal.textContent = "0 ₽";
      // Сообщаем ИИ-ассистенту, что корзина пуста.
      window.__gravityCart = [];
      return;
    }

    cartEmpty.style.display = "none";
    let total = 0;
    state.maxPrep = 0;

    state.cart.forEach((entry) => {
      const item = menuItems.find((m) => m.id === entry.id);
      if (!item) return;
      total += item.price * entry.qty;
      state.maxPrep = Math.max(state.maxPrep, item.prep_time);

      const el = document.createElement("div");
      el.className = "cart-item";

      const img = document.createElement("img");
      img.src = item.image_url || "";
      img.alt = item.name;

      const info = document.createElement("div");
      const metaDiv = document.createElement("div");
      metaDiv.className = "menu-meta";
      metaDiv.style.marginBottom = "6px";
      const strong = document.createElement("strong");
      strong.textContent = item.name;
      const timeSpan = document.createElement("span");
      timeSpan.className = "muted small";
      timeSpan.textContent = `${item.prep_time} мин`;
      metaDiv.appendChild(strong);
      metaDiv.appendChild(timeSpan);
      const priceDiv = document.createElement("div");
      priceDiv.className = "muted small";
      priceDiv.textContent = `${item.price} ₽`;
      info.appendChild(metaDiv);
      info.appendChild(priceDiv);

      const qtyDiv = document.createElement("div");
      qtyDiv.className = "qty";
      const minus = document.createElement("button");
      minus.setAttribute("aria-label", "Убрать");
      minus.textContent = "-";
      minus.addEventListener("click", () => changeQuantity(entry.id, -1));
      const qtySpan = document.createElement("span");
      qtySpan.textContent = String(entry.qty);
      const plus = document.createElement("button");
      plus.setAttribute("aria-label", "Добавить");
      plus.textContent = "+";
      plus.addEventListener("click", () => changeQuantity(entry.id, 1));
      qtyDiv.appendChild(minus);
      qtyDiv.appendChild(qtySpan);
      qtyDiv.appendChild(plus);

      el.appendChild(img);
      el.appendChild(info);
      el.appendChild(qtyDiv);
      cartItems.appendChild(el);
    });

    prepTime.textContent = `${state.maxPrep} минут`;
    cartTotal.textContent = `${total} ₽`;

    // Отдаём состав корзины ИИ-ассистенту (см. src/ai-assistant.js).
    // Ассистент видит выбор гостя и советует с учётом уже собранного заказа.
    window.__gravityCart = state.cart
      .map((entry) => {
        const item = menuItems.find((m) => m.id === entry.id);
        return item ? { name: item.name, quantity: entry.qty, price: item.price } : null;
      })
      .filter(Boolean);
  }

  function addToCart(id) {
    const existing = state.cart.find((c) => c.id === id);
    if (existing) existing.qty += 1;
    else state.cart.push({ id, qty: 1 });
    updateCart();
  }

  function changeQuantity(id, delta) {
    state.cart = state.cart
      .map((entry) =>
        entry.id === id ? { ...entry, qty: entry.qty + delta } : entry
      )
      .filter((entry) => entry.qty > 0);
    updateCart();
  }

  function openCart() {
    cartOverlay?.classList.add("open");
    cartPanel?.classList.add("open");
  }

  function closeCart() {
    cartOverlay?.classList.remove("open");
    cartPanel?.classList.remove("open");
  }

  openCartBtn?.addEventListener("click", openCart);
  closeCartBtn?.addEventListener("click", closeCart);
  cartOverlay?.addEventListener("click", closeCart);

  orderSaveBtn?.addEventListener("click", () => {
    if (orderSaveNote) {
      orderSaveNote.style.display = "block";
      setTimeout(() => {
        orderSaveNote.style.display = "none";
      }, 2400);
    }
  });

  orderForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.cart.length) {
      alert("Добавьте блюда в корзину, чтобы оформить предзаказ.");
      return;
    }

    const savedUser = localStorage.getItem("user");
    const token = localStorage.getItem("token");
    if (!token || !savedUser) {
      window.openAuthModal();
      return;
    }

    let userProfile;
    try {
      userProfile = JSON.parse(savedUser);
    } catch (_) {
      window.openAuthModal();
      return;
    }

    const submitBtn = orderForm.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Отправка...";

    try {
      const result = await api.submitOrder({
        customer_name: userProfile.name,
        phone: userProfile.phone,
        order_date: orderDate?.value || "",
        order_time: orderTime?.value || "",
        area_slug: orderArea?.value || "",
        table_number: parseInt(orderTable?.value) || 0,
        items: state.cart.map((c) => ({
          menu_item_id: c.id,
          quantity: c.qty,
        })),
      });

      document.getElementById("confirm-name").textContent = result.customer_name;
      document.getElementById("confirm-date").textContent = result.order_date;
      document.getElementById("confirm-time").textContent = result.order_time;
      document.getElementById("confirm-area").textContent = result.area_name;
      document.getElementById("confirm-table").textContent = result.table_number;
      document.getElementById("confirm-total").textContent = `${result.total} ₽`;
      document.getElementById("confirm-ready").textContent = result.ready_time;

      orderForm.style.display = "none";
      confirmation.style.display = "block";
    } catch (err) {
      alert("Ошибка при оформлении заказа: " + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Оформить предзаказ";
    }
  });

  newOrderBtn?.addEventListener("click", () => {
    state.cart = [];
    updateCart();
    orderForm?.reset();
    orderForm.style.display = "block";
    confirmation.style.display = "none";
  });

  closeConfirmBtn?.addEventListener("click", () => {
    closeCart();
  });

  renderTabs();
  renderMenu();
  updateCart();
}

// форма бронирования: выбор зоны, столиков и подтверждение
async function initReservationPage() {
  const form = document.getElementById("reservation-form");
  if (!form) return;

  const areaChoices = document.getElementById("area-choices");
  const tableGrid = document.getElementById("table-grid");
  const timeSelect = document.getElementById("res-time");
  const dateInput = document.getElementById("res-date");
  const guestsSelect = document.getElementById("res-guests");
  const successBlock = document.getElementById("reservation-success");
  const newReservationBtn = document.getElementById("new-reservation");

  const successArea = document.getElementById("success-area");
  const successDate = document.getElementById("success-date");
  const successTime = document.getElementById("success-time");
  const successGuests = document.getElementById("success-guests");
  const successTable = document.getElementById("success-table");
  const successPhone = document.getElementById("success-phone");

  let areasData, timeSlots;
  try {
    [areasData, timeSlots] = await Promise.all([
      api.getAreas(),
      api.getTimeSlots(),
    ]);
  } catch (err) {
    if (areaChoices) {
      areaChoices.innerHTML =
        '<div class="error-banner"><p>Не удалось загрузить данные.</p><button class="btn" onclick="location.reload()">Обновить</button></div>';
    }
    return;
  }

  if (dateInput) {
    dateInput.min = new Date().toISOString().split("T")[0];
  }

  timeSlots.forEach((slot) => {
    const option = document.createElement("option");
    option.value = slot;
    option.textContent = slot;
    timeSelect?.appendChild(option);
  });

  // рендерим кнопки зон динамически из API
  const areaIcons = { indoor: "🏠", terrace: "🌿", outdoor: "✨" };
  const areaDescriptions = {
    indoor: "Уютная атмосфера и приглушённый свет",
    terrace: "Крытая терраса с видом на город",
    outdoor: "Свежий воздух и живая атмосфера",
  };

  let selectedArea = "";
  let selectedTable = null;

  function renderAreaButtons() {
    if (!areaChoices) return;
    areaChoices.innerHTML = "";
    areasData.forEach((area) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `card feature-card${selectedArea === area.slug ? " selected" : ""}`;
      btn.dataset.area = area.slug;

      const iconDiv = document.createElement("div");
      iconDiv.className = "feature-icon";
      iconDiv.textContent = areaIcons[area.slug] || "📍";

      const h4 = document.createElement("h4");
      h4.textContent = area.name;

      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = areaDescriptions[area.slug] || "";

      btn.appendChild(iconDiv);
      btn.appendChild(h4);
      btn.appendChild(p);

      btn.addEventListener("click", () => {
        selectedArea = area.slug;
        selectedTable = null;
        renderAreaButtons();
        renderTables();
      });

      areaChoices.appendChild(btn);
    });
  }

  function renderTables() {
    if (!tableGrid) return;
    tableGrid.innerHTML = "";
    if (!selectedArea) return;

    const area = areasData.find((a) => a.slug === selectedArea);
    if (!area) return;

    area.tables.forEach((table) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn ${selectedTable === table ? "btn-primary" : ""}`;
      btn.textContent = `Столик ${table}`;
      btn.addEventListener("click", () => {
        selectedTable = table;
        renderTables();
      });
      tableGrid.appendChild(btn);
    });
  }

  renderAreaButtons();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!selectedArea || !selectedTable) {
      alert("Пожалуйста, выберите зону и столик.");
      return;
    }

    const savedUser = localStorage.getItem("user");
    const token = localStorage.getItem("token");
    if (!token || !savedUser) {
      window.openAuthModal();
      return;
    }

    let userProfile;
    try {
      userProfile = JSON.parse(savedUser);
    } catch (_) {
      window.openAuthModal();
      return;
    }

    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Отправка...";

    try {
      const result = await api.submitReservation({
        customer_name: userProfile.name,
        phone: userProfile.phone,
        reservation_date: dateInput?.value,
        reservation_time: timeSelect?.value,
        guests: parseInt(guestsSelect?.value),
        area_slug: selectedArea,
        table_number: selectedTable,
      });

      successArea.textContent = result.area_name;
      successDate.textContent = result.reservation_date;
      successTime.textContent = result.reservation_time;
      successGuests.textContent = result.guests;
      successTable.textContent = result.table_number;
      successPhone.textContent = userProfile.phone;

      form.style.display = "none";
      successBlock.style.display = "block";
    } catch (err) {
      alert("Ошибка при бронировании: " + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Подтвердить бронирование";
    }
  });

  newReservationBtn?.addEventListener("click", () => {
    form.reset();
    selectedArea = "";
    selectedTable = null;
    renderAreaButtons();
    renderTables();
    form.style.display = "block";
    successBlock.style.display = "none";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  setupNav();
  animateHeroReveal();
  initAuth();
  initMenuPage();
  initReservationPage();
  initProfilePage();
  initSettings();
  // ИИ-ассистент кафе: чат-виджет в правом нижнем углу на всех страницах.
  initAssistant();
});
