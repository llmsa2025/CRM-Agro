import { Fragment } from "react";
import Link from "next/link";

export type Crumb = { label: string; href?: string };

/**
 * Trilha de navegação compacta ("Pai / Sub /") em 13px tinta-3 — identidade v2.
 * Sem botão "Voltar": a trilha já leva ao pai e o navegador tem o histórico.
 */
export function PageNav({ items }: { items: Crumb[]; backHref?: string }) {
  return (
    <nav aria-label="Caminho" className="flex items-center gap-1 text-small text-ink-3">
      {items.map((it, i) => (
        <Fragment key={i}>
          {it.href ? (
            <Link href={it.href} className="transition-colors hover:text-foreground">
              {it.label}
            </Link>
          ) : (
            <span className="text-foreground">{it.label}</span>
          )}
          {i < items.length - 1 && <span aria-hidden>/</span>}
        </Fragment>
      ))}
    </nav>
  );
}
