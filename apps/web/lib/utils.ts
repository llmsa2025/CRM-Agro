import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * `twMerge` só conhece os tamanhos padrão do Tailwind. Sem isto, `text-num`
 * (tamanho do guia) e `text-success-500` (cor) caem no mesmo grupo e o
 * primeiro é descartado — o número perdia o tamanho ao ganhar cor.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "title", "num", "h1", "h2", "h3", "label", "body", "body-lg", "caption", "small"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
