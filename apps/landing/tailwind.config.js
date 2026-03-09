/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        surface: {
          900: "#0a0a0b",
          800: "#111113",
          700: "#18181b",
          600: "#27272a",
          500: "#3f3f46",
        },
        accent: {
          DEFAULT: "#e4e4e7",
          muted: "#a1a1aa",
          dim: "#71717a",
        },
        border: {
          DEFAULT: "#27272a",
          light: "#3f3f46",
        },
        brand: {
          DEFAULT: "#22c55e",
          muted: "rgba(34, 197, 94, 0.15)",
        },
      },
    },
  },
  plugins: [],
};
