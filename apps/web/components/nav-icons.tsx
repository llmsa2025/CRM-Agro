import type { SVGProps } from "react";

/**
 * Ícones do menu (traço 1.6, 16px) — os mesmos desenhos dos mockups v2, em
 * SVG inline para o menu não depender do lucide e ficar idêntico ao aprovado.
 */
const PATHS = {
  painel: "M4 4h6v7H4zM14 4h6v4h-6zM14 12h6v8h-6zM4 15h6v5H4z",
  atividades: "m4 17 2 2 3.5-3.5M4 7l2 2 3.5-3.5M13 6h7M13 12h7M13 18h7",
  conversas: "M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z",
  ligacoes:
    "M21 16.4v2.8a1.8 1.8 0 0 1-2 1.8 17.8 17.8 0 0 1-7.8-2.8 17.5 17.5 0 0 1-5.4-5.4A17.8 17.8 0 0 1 3 5a1.8 1.8 0 0 1 1.8-2h2.8a1.8 1.8 0 0 1 1.8 1.6c.1.9.3 1.7.6 2.5a1.8 1.8 0 0 1-.4 1.9L8.4 10.2a14.4 14.4 0 0 0 5.4 5.4l1.2-1.2a1.8 1.8 0 0 1 1.9-.4c.8.3 1.6.5 2.5.6a1.8 1.8 0 0 1 1.6 1.8z",
  agenda: "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM16 3v4M8 3v4M4 10h16",
  contatos:
    "M15 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 3 18.5V20M9 4a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M21 20v-1.5a3.5 3.5 0 0 0-2.5-3.4M15.5 4.1a3.5 3.5 0 0 1 0 6.8",
  campanhas: "M4 10v4a1 1 0 0 0 1 1h2l5 4V5L7 9H5a1 1 0 0 0-1 1zM16 8.5a4.5 4.5 0 0 1 0 7M19 6a8 8 0 0 1 0 12",
  captacao: "M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8",
  funis: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v6h-4z",
  fluxos: "M6 3a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M18 16a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M6 8v3a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3",
  mapa: "M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
  integracoes: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  configuracoes: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
} as const;

export type NavIconName = keyof typeof PATHS;

export function NavIcon({ name, ...props }: { name: NavIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
