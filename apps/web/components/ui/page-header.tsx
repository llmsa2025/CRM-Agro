import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Cabeçalho de página canônico (identidade v2):
 *   breadcrumb "Pai /" 13px tinta-3 (opcional) · título serif 30px peso 400 ·
 *   subtítulo 14px tinta-2 = DADO ("1.284 pessoas · 312 empresas"), não slogan ·
 *   ações à direita alinhadas à base (secundário antes do primário).
 *
 * É a fonte única de "topo de tela": nenhuma página monta título+ações à mão.
 */
export interface Breadcrumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  /** Título da página — vira o único `h1` da tela. */
  title: React.ReactNode;
  /** Contagem/dado inline ao lado do título (raro — prefira `subtitle`). */
  count?: React.ReactNode;
  /** Linha de apoio abaixo do título: sempre um dado, nunca frase de marketing. */
  subtitle?: React.ReactNode;
  /** Ações à direita (botões). */
  actions?: React.ReactNode;
  /** Trilha "Pai /" acima do título. */
  breadcrumb?: Breadcrumb[];
  /** Seta de voltar à esquerda da trilha (href da tela-mãe). */
  back?: string;
  /** Elemento à esquerda do título (avatar da ficha do contato, por exemplo). */
  leading?: React.ReactNode;
  divider?: boolean;
  className?: string;
}

export function PageHeader({
  title,
  count,
  subtitle,
  actions,
  breadcrumb,
  back,
  leading,
  divider = false,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", divider && "border-b border-line pb-5", className)}>
      {((breadcrumb && breadcrumb.length > 0) || back) && (
        <nav aria-label="Caminho" className="flex items-center gap-1 text-small text-ink-3">
          {back && (
            <Link
              href={back}
              aria-label="Voltar"
              className="mr-1 inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          )}
          {(breadcrumb ?? []).map((item, i) => (
            <React.Fragment key={`${item.label}-${i}`}>
              {item.href ? (
                <Link href={item.href} className="rounded-sm transition-colors hover:text-foreground">
                  {item.label}
                </Link>
              ) : (
                <span>{item.label}</span>
              )}
              <span aria-hidden>/</span>
            </React.Fragment>
          ))}
        </nav>
      )}

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-4">
          {leading}
          <div className="min-w-0">
            <div className="flex items-baseline gap-3">
              <h1 className="font-serif text-title text-foreground">{title}</h1>
              {count != null && <span className="num whitespace-nowrap text-small text-ink-2">{count}</span>}
            </div>
            {subtitle && <p className="num mt-1.5 text-body text-ink-2">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * Título de seção. Na coluna principal: serif 20px peso 400. Na coluna lateral
 * (`variant="aside"`): sans 13px peso 600. Sempre com hairline abaixo e
 * altura 44px, para as seções alinharem entre colunas.
 */
export function SectionHeader({
  title,
  aside,
  variant = "main",
  className,
  id,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  variant?: "main" | "aside";
  className?: string;
  id?: string;
}) {
  return (
    <div className={cn("flex h-11 items-center gap-3 border-b border-line", className)}>
      <h2
        id={id}
        className={cn(
          "min-w-0 flex-1",
          variant === "main" ? "font-serif text-h2 text-foreground" : "text-label text-foreground",
        )}
      >
        {title}
      </h2>
      {aside && <div className="flex shrink-0 items-center gap-3 text-small text-ink-2">{aside}</div>}
    </div>
  );
}
