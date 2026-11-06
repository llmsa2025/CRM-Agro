import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

/**
 * Identidade v2 do CRM Agro.
 *
 * Os NOMES semânticos (background, foreground, primary, muted, brand-*, success/
 * warning/danger…) são mantidos para que todo o código existente continue
 * compilando; só os VALORES mudam (ver globals.css). Tokens novos, com o nome do
 * guia: ink (tinta), line (linha), paper (papel), sidebar (menu) e sol.
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1400px" } },
    extend: {
      fontFamily: {
        // Instrument Sans na interface; Newsreader (serifa editorial) em títulos
        // e números de destaque. Carregadas por next/font em app/layout.tsx.
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        // Escala do guia: título de página 30/1.2, número de destaque 28/1.1,
        // título de seção 20/1.3, corpo 14/1.5, rótulo 13, legenda 12.
        display: ["1.875rem", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "400" }],
        title: ["1.875rem", { lineHeight: "1.2", letterSpacing: "-0.01em", fontWeight: "400" }],
        num: ["1.75rem", { lineHeight: "1.1", fontWeight: "400" }],
        h1: ["1.25rem", { lineHeight: "1.3", fontWeight: "400" }],
        h2: ["1.25rem", { lineHeight: "1.3", fontWeight: "400" }],
        h3: ["0.875rem", { lineHeight: "1.4", fontWeight: "600" }],
        label: ["0.8125rem", { lineHeight: "1.4", fontWeight: "600" }],
        body: ["0.875rem", { lineHeight: "1.5" }],
        "body-lg": ["1rem", { lineHeight: "1.5" }],
        caption: ["0.75rem", { lineHeight: "1.35" }],
        small: ["0.8125rem", { lineHeight: "1.4" }],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        paper: "hsl(var(--background))",
        ink: {
          DEFAULT: "hsl(var(--foreground))",
          2: "hsl(var(--ink-2))",
          3: "hsl(var(--ink-3))",
        },
        line: {
          DEFAULT: "hsl(var(--border))",
          strong: "hsl(var(--input))",
        },
        hover: "hsl(var(--accent))",
        sol: "hsl(var(--sol))",
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          muted: "hsl(var(--sidebar-muted))",
          label: "hsl(var(--sidebar-label))",
          active: "hsl(var(--sidebar-active))",
          border: "hsl(var(--sidebar-border))",
          ok: "hsl(var(--sidebar-ok))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        brand: {
          50: "hsl(var(--brand-50))",
          100: "hsl(var(--brand-100))",
          200: "hsl(var(--brand-200))",
          300: "hsl(var(--brand-300))",
          400: "hsl(var(--brand-400))",
          500: "hsl(var(--brand-500))",
          600: "hsl(var(--brand-600))",
          700: "hsl(var(--brand-700))",
          foreground: "hsl(var(--brand-foreground))",
        },
        success: {
          100: "hsl(var(--success-100))",
          500: "hsl(var(--success-500))",
          600: "hsl(var(--success-500))",
          700: "hsl(var(--success-700))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          100: "hsl(var(--warning-100))",
          500: "hsl(var(--warning-500))",
          600: "hsl(var(--warning-500))",
          700: "hsl(var(--warning-700))",
          foreground: "hsl(var(--warning-foreground))",
        },
        danger: {
          100: "hsl(var(--danger-100))",
          500: "hsl(var(--danger-500))",
          600: "hsl(var(--danger-500))",
          700: "hsl(var(--danger-700))",
          foreground: "hsl(var(--danger-foreground))",
        },
        info: {
          100: "hsl(var(--info-100))",
          500: "hsl(var(--info-500))",
          700: "hsl(var(--info-700))",
        },
        // Cores de etapa do funil: da paleta de status (sem arco-íris).
        stage: {
          1: "hsl(var(--brand-500))",
          2: "hsl(var(--info-500))",
          3: "hsl(var(--success-500))",
          4: "hsl(var(--warning-500))",
          5: "hsl(var(--ink-3))",
          6: "hsl(var(--danger-500))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "var(--radius)",
        sm: "calc(var(--radius) - 2px)",
      },
      boxShadow: {
        // Sem sombra em superfícies. Só popover/modal tem elevação.
        xs: "none",
        sm: "none",
        md: "0 8px 24px rgba(26, 31, 28, 0.08)",
        lg: "0 8px 24px rgba(26, 31, 28, 0.08)",
        popover: "0 8px 24px rgba(26, 31, 28, 0.08)",
        focus: "0 0 0 2px hsl(var(--background)), 0 0 0 4px hsl(var(--ring) / 0.35)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
