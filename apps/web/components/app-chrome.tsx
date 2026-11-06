"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Bell, Menu, Search, X } from "lucide-react";
import { AppSidebar } from "@/components/app-sidebar";
import { Logo } from "@/components/brand/logo";
import { AssistantWidget } from "@/components/assistant-widget";
import { AgendaAlerts } from "@/components/agenda-alerts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { UsuarioSessao } from "@/components/user-menu";
import { cn } from "@/lib/utils";

/**
 * Casca da aplicação (menu lateral verde + barra superior branca).
 *
 * Telas de acesso (login, criar conta, senha) são renderizadas "peladas": mostrar
 * a navegação para quem não entrou sugere acesso que a pessoa não tem.
 *
 * Telas de tela cheia (construtor de fluxo) ocupam a área sem o padding padrão.
 */
const SEM_CASCA = ["/login", "/criar-conta", "/esqueci-senha", "/redefinir-senha"];
const TELA_CHEIA = [/^\/fluxos\/[^/]+$/, /^\/conversas/, /^\/mapa/];

/** Eventos globais usados pela barra superior para abrir os painéis. */
export const EVENTO_BUSCA = "crmagro:busca:abrir";
export const EVENTO_ASSISTENTE = "crmagro:assistente:alternar";

export function AppChrome({
  children,
  usuario,
  naoLidas = 0,
  telas = null,
}: {
  children: ReactNode;
  usuario: UsuarioSessao | null;
  /** Conversas não lidas (contador do menu). */
  naoLidas?: number;
  /** Telas liberadas (F2b); null = todas. */
  telas?: string[] | null;
}) {
  const pathname = usePathname() ?? "/";
  const [menuAberto, setMenuAberto] = useState(false);
  // Menu recolhido (só ícones) no desktop — lembrado no navegador.
  const [recolhido, setRecolhido] = useState(false);
  useEffect(() => {
    try {
      setRecolhido(localStorage.getItem("crmagro:menu:recolhido") === "1");
    } catch {
      /* navegador sem storage */
    }
  }, []);
  function alternarMenu() {
    setRecolhido((v) => {
      const novo = !v;
      try {
        localStorage.setItem("crmagro:menu:recolhido", novo ? "1" : "0");
      } catch {
        /* ignora */
      }
      return novo;
    });
  }

  // Fecha o menu móvel ao navegar.
  useEffect(() => setMenuAberto(false), [pathname]);

  if (SEM_CASCA.some((p) => pathname.startsWith(p)) || !usuario) {
    return <main className="min-h-screen">{children}</main>;
  }

  const telaCheia = TELA_CHEIA.some((re) => re.test(pathname));

  return (
    <div className="flex min-h-screen">
      {/* Menu lateral — fixo no desktop; gaveta no mobile. */}
      <div className="sticky top-0 hidden h-screen md:block">
        <AppSidebar usuario={usuario} naoLidas={naoLidas} telas={telas} recolhido={recolhido} onToggle={alternarMenu} />
      </div>
      {menuAberto && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="Fechar menu"
            className="absolute inset-0 bg-black/30"
            onClick={() => setMenuAberto(false)}
          />
          <div className="absolute inset-y-0 left-0">
            <AppSidebar usuario={usuario} naoLidas={naoLidas} telas={telas} onNavigate={() => setMenuAberto(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-[52px] items-center gap-3 border-b bg-background px-4 md:px-10">
          {/* Mobile: marca + hambúrguer. */}
          <button
            type="button"
            aria-label={menuAberto ? "Fechar menu" : "Abrir menu"}
            onClick={() => setMenuAberto((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 hover:bg-accent md:hidden"
          >
            {menuAberto ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <Link href="/" className="md:hidden" aria-label="CRM Agro, início">
            <Logo tone="dark" size={20} />
          </Link>

          {/* Busca global: abre a paleta de comandos (Ctrl K). */}
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent(EVENTO_BUSCA))}
            className="hidden h-[34px] w-[380px] items-center gap-2 rounded-md text-left text-body text-ink-3 transition-colors hover:text-ink-2 md:flex"
          >
            <Search className="h-[15px] w-[15px] shrink-0" />
            <span className="flex-1 truncate">Buscar contato, empresa ou número</span>
            <kbd className="rounded border bg-background px-1.5 py-px font-sans text-caption font-medium text-ink-3">Ctrl K</kbd>
          </button>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent(EVENTO_ASSISTENTE))}
              className="h-8 rounded-md border border-line-strong bg-background px-3 text-small font-medium text-foreground transition-colors hover:bg-accent"
            >
              Assistente
            </button>
            {/* O sino leva à Agenda: só para quem tem a tela (F2b; antes caía em /sem-acesso). */}
            {(!telas || telas.includes("agenda")) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/agenda"
                  aria-label="Compromissos"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Bell className="h-4 w-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent>Compromissos de hoje</TooltipContent>
            </Tooltip>
            )}
          </div>
        </header>

        <main className={cn("min-w-0 flex-1", telaCheia ? "flex flex-col" : "px-4 py-6 md:px-10 md:py-9")}>{children}</main>
      </div>

      <AssistantWidget />
      {/* Alertas da agenda só para quem tem a tela Agenda (F2b): sem ela, a action recusaria a cada minuto. */}
      {(!telas || telas.includes("agenda")) && <AgendaAlerts />}
    </div>
  );
}
