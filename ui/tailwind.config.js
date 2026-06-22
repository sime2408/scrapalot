import { fontFamily } from "tailwindcss/defaultTheme";
import tailwindcssAnimate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    screens: {
      // Bootstrap-based breakpoint system (aligned with use-mobile.tsx hooks)
      'xs': '576px',   // Extra small >=576px
      'sm': '576px',   // Small >=576px (Tailwind default override)
      'md': '768px',   // Medium >=768px (tablet) - matches MOBILE_BREAKPOINT
      'lg': '992px',   // Large >=992px (desktop) - matches DESKTOP_BREAKPOINT & TABLET_BREAKPOINT
      'xl': '1200px',  // Extra large >=1200px (wide desktop) - matches WIDE_DESKTOP_BREAKPOINT
      '2xl': '1400px', // Extra extra large >=1400px
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
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
        // Adding sidebar colors
        "chat-sidebar": "hsl(var(--chat-sidebar))",
        "chat-sidebar-foreground": "hsl(var(--chat-sidebar-foreground))",
        "chat-sidebar-border": "hsl(var(--chat-sidebar-border))",
        "chat-sidebar-button": "hsl(var(--chat-sidebar-button))",
        "chat-sidebar-button-hover": "hsl(var(--chat-sidebar-button-hover))",
        "sidebar-background": "hsl(var(--sidebar-background))",
        "sidebar-foreground": "hsl(var(--sidebar-foreground))",
        "sidebar-border": "hsl(var(--sidebar-border))",
        "sidebar-primary": "hsl(var(--sidebar-primary))",
        "sidebar-primary-foreground": "hsl(var(--sidebar-primary-foreground))",
        "sidebar-accent": "hsl(var(--sidebar-accent))",
        "sidebar-accent-foreground": "hsl(var(--sidebar-accent-foreground))",
        "sidebar-ring": "hsl(var(--sidebar-ring))",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["Inter var", ...fontFamily.sans],
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
        "pulse-slow": {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.6 },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "accordion-down-slow": "accordion-down 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
        "accordion-up-slow": "accordion-up 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
        "pulse-slow": "pulse-slow 3s ease-in-out infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
