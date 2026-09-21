import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        menu: resolve(__dirname, "menu.html"),
        reservation: resolve(__dirname, "reservation.html"),
        about: resolve(__dirname, "about.html"),
        profile: resolve(__dirname, "profile.html"),
      },
    },
  },
});
