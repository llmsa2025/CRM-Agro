"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo, LogoMark } from "@/components/brand/logo";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NavIcon, type NavIconName } from "@/components/nav-icons";
import { UserMenu, type UsuarioSessao } from "@/components/user-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────────
 *  Menu lateral — identidade v2.3 (24/09/2026)
 *
 *  Superfície verde-mata, 240px. Três seções: Dia a dia · Ferramentas · Sistema.
 *  Item ativo: fundo #2E5D4B, texto branco, ícone dourado (sol).
 *  Rodapé: saúde do WhatsApp (envios do dia) + usuário com menu.
 * ──────────────────────────────────────────────────────────────────────────── */

type NavItem = {
  id: NavIconName;
  label: string;
  href: string;
  /** Rotas que também contam como "ativo" (sub-telas). */
  match?: string[];
  /** Ainda não existe no produto (fica visível, desabilitado). */
  emBreve?: boolean;
  /** Contador discreto à direita (ex.: conversas não lidas). */
  count?: number;
};

type NavSection = { title: string; items: NavItem[] };

function secoes(naoLidas: number): NavSection[] {
  return [
    {
      title: "Dia a dia",
      items: [
        { id: "painel", label: "Painel", href: "/" },
        { id: "atividades", label: "Atividades", href: "/atividades" },
        { id: "conversas", label: "Conversas", href: "/conversas", count: naoLidas },
        { id: "ligacoes", label: "Ligações", href: "/ligacoes" },
        { id: "agenda", label: "Agenda", href: "/agenda" },
      ],
    },
    {
      title: "Ferramentas",
      items: [
        { id: "contatos", label: "Contatos", href: "/contatos" },
        { id: "campanhas", label: "Campanhas", href: "/campanhas" },
        { id: "captacao", label: "Captação", href: "/captacao" },
        { id: "funis", label: "Funis", href: "/funis" },
        { id: "fluxos", label: "Fluxos", href: "/fluxos" },
        { id: "mapa", label: "Mapa", href: "/mapa" },
      ],
    },
    {
      title: "Sistema",
      items: [
        { id: "integracoes", label: "Integrações", href: "/integracoes", match: ["/integracoes"] },
        { id: "configuracoes", label: "Configurações", href: "/configuracoes" },
      ],
    },
  ];
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === "/") return pathname === "/";
  return pathname.startsWith(item.href) || (item.match ?? []).some((m) => pathname.startsWith(m));
}

function NavLeaf({ item, active, recolhido = false }: { item: NavItem; active: boolean; recolhido?: boolean }) {
  const inner = (
    <span
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-md text-body transition-colors",
        recolhido ? "justify-center px-0" : "px-2.5",
        active ? "bg-sidebar-active font-semibold text-sidebar-foreground" : "font-normal text-sidebar-muted hover:bg-sidebar-active/60 hover:text-sidebar-foreground",
        item.emBreve && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-sidebar-muted",
      )}
    >
      <NavIcon name={item.id} className={cn("shrink-0", active ? "text-sol" : "text-sidebar-label")} />
      {!recolhido && <span className="flex-1 truncate">{item.label}</span>}
      {!recolhido && item.count ? <span className="num text-caption font-medium text-sidebar-muted">{item.count}</span> : null}
      {recolhido && item.count ? <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-sol" aria-hidden /> : null}
    </span>
  );

  // Recolhido: só o ícone, com o nome (e a contagem) na dica.
  if (recolhido && !item.emBreve) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Link href={item.href} aria-current={active ? "page" : undefined} aria-label={item.label}>
            {inner}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">
          {item.label}
          {item.count ? ` · ${item.count}` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (item.emBreve) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="block">{inner}</span>
        </TooltipTrigger>
        <TooltipContent side="right">Em breve</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined}>
      {inner}
    </Link>
  );
}

export function AppSidebar({
  usuario,
  naoLidas = 0,
  className,
  onNavigate,
  recolhido = false,
  onToggle,
  telas = null,
}: {
  usuario?: UsuarioSessao | null;
  naoLidas?: number;
  /** Telas liberadas para a pessoa (F2b); null = todas. */
  telas?: string[] | null;
  className?: string;
  /** Chamado ao clicar num item (fecha o menu no mobile). */
  onNavigate?: () => void;
  /** Só ícones (desktop). */
  recolhido?: boolean;
  /** Ícone de recolher/expandir no topo (só aparece com o mouse sobre o menu); sem ele, não há botão (mobile). */
  onToggle?: () => void;
}) {
  const pathname = usePathname() ?? "/";

  return (
    <aside
      className={cn(
        "group/menu flex h-screen shrink-0 flex-col gap-6 bg-sidebar pb-4 pt-5 text-sidebar-foreground transition-[width]",
        recolhido ? "w-16 px-2" : "w-60 px-3",
        className,
      )}
    >
      {/* Topo: logo + ícone de recolher/expandir. Expandido, o ícone só aparece com
          o mouse sobre o menu (ou foco por teclado). Recolhido, a marca fica SEMPRE
          visível e o ícone de expandir vem logo abaixo dela — antes, o foco que
          sobrava no botão depois do clique escondia os dois. */}
      <div className={cn("flex items-center", recolhido ? "flex-col gap-1" : "h-7 justify-between pl-2.5")}>
        <Link href="/" aria-label="CRM Agro, início" className="py-0.5" onClick={onNavigate}>
          {recolhido ? <LogoMark tone="light" size={24} /> : <Logo tone="light" size={24} />}
        </Link>
        {onToggle && (
          <button
            type="button"
            onClick={(e) => {
              onToggle();
              e.currentTarget.blur();
            }}
            aria-label={recolhido ? "Expandir menu" : "Recolher menu"}
            title={recolhido ? "Expandir menu" : "Recolher menu"}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md text-sidebar-label transition-opacity hover:bg-sidebar-active/60 hover:text-sidebar-foreground",
              recolhido ? "opacity-70 hover:opacity-100" : "opacity-0 focus-visible:opacity-100 group-hover/menu:opacity-100",
            )}
          >
            {recolhido ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* min-h-0: o nav encolhe e rola por dentro, então o rodapé (usuário) fica
          sempre à vista; a barra de rolagem é escondida (`rolagem-sem-barra`). */}
      <nav
        className={cn("rolagem-sem-barra flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain", recolhido ? "gap-4" : "gap-6")}
        onClick={onNavigate}
      >
        {secoes(naoLidas)
          .map((section) => ({ ...section, items: section.items.filter((i) => !telas || telas.includes(i.id)) }))
          .filter((section) => section.items.length > 0)
          .map((section) => (
          <div key={section.title} className="flex flex-col gap-px">
            {recolhido ? (
              <div className="mx-2 mb-1.5 border-t border-sidebar-border first:hidden" aria-hidden />
            ) : (
              <div className="px-2.5 pb-1.5 text-caption font-medium text-sidebar-label">{section.title}</div>
            )}
            {section.items.map((item) => (
              <NavLeaf key={item.id} item={item} active={isActive(pathname, item)} recolhido={recolhido} />
            ))}
          </div>
        ))}
      </nav>

      {usuario && <UserMenu usuario={usuario} compact={recolhido} />}
    </aside>
  );
}
