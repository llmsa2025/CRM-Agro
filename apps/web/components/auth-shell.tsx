import { Logo } from "@/components/brand/logo";

/**
 * Casca das telas de acesso (identidade v2): painel verde-mata à esquerda com
 * a marca e uma frase em serifa; formulário à direita, centrado, título serif.
 * Compartilhada por login, esqueci-senha, redefinir-senha e criar-conta.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[5fr_7fr]">
      <aside className="hidden flex-col justify-between bg-sidebar p-14 text-sidebar-foreground lg:flex">
        <Logo tone="light" size={26} />
        <div className="max-w-md">
          <h2 className="font-serif text-[56px] font-light leading-[1.08] tracking-[-0.01em]">
            Prospecção que respeita o ritmo do campo.
          </h2>
          <p className="mt-8 max-w-sm text-body leading-relaxed text-sidebar-muted">
            Campanhas, conversas e funil no mesmo lugar. Feito para quem vende para o
            agro.
          </p>
        </div>
        <span aria-hidden />
      </aside>

      <main className="relative flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-[360px]">
          <div className="mb-10 lg:hidden">
            <Logo tone="dark" size={24} />
          </div>
          <h1 className="font-serif text-title text-foreground">{title}</h1>
          {subtitle && <p className="mt-2 text-body text-ink-2">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 border-t border-line pt-6 text-small text-ink-2">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
