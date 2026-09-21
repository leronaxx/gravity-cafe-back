const API_BASE = "/api";

async function request(path, options = {}) {
  const token = localStorage.getItem("token");
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  getMenu: (category) =>
    request(category ? `/menu?category=${category}` : "/menu"),
  getCategories: () => request("/categories"),
  getAreas: () => request("/areas"),
  getTimeSlots: () => request("/time-slots"),
  getSettings: () => request("/settings"),
  submitOrder: (data) =>
    request("/orders", { method: "POST", body: JSON.stringify(data) }),
  submitReservation: (data) =>
    request("/reservations", { method: "POST", body: JSON.stringify(data) }),
  register: (data) => request("/auth/register", { method: "POST", body: JSON.stringify(data) }),
  login: (data) => request("/auth/login", { method: "POST", body: JSON.stringify(data) }),
  getMe: () => request("/auth/me"),
  getMyOrders: () => request("/auth/orders"),
  getMyReservations: () => request("/auth/reservations"),
};
