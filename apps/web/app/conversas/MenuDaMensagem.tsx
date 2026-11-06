"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Copy, ListChecks, Share2 } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/** Onde o menu abre (coordenadas da janela) e como foi pedido (mouse/toque ou teclado). */
export type AlvoDoMenu = { x: number; y: number; via: "mouse" | "teclado" };

export type AcaoDoMenu = "copiar" | "selecionar" | "compartilhar";

/**
 * Menu pequeno da mensagem: Copiar, Selecionar e Compartilhar. Uma única
 * instância para a conversa toda (aberta no ponto do clique direito, do toque
 * longo, da seta da mensagem ou do bubble com a tecla de menu / Shift+F10).
 *
 * Usa o menu do Radix (o mesmo do resto do CRM Agro): `role="menu"`, itens com
 * `role="menuitem"`, setas do teclado, Esc fecha, clique fora fecha. O que este
 * componente acrescenta:
 * - a âncora é um ponto invisível de 1 px na posição pedida (o Radix ajusta se
 *   faltar espaço na janela);
 * - aberto pelo teclado, o foco já cai no primeiro item;
 * - ao fechar por Esc ou por escolher uma ação, o foco volta para a mensagem
 *   (`aoDevolverFoco`); fechando por clique fora, o foco fica onde a pessoa clicou.
 *   "Compartilhar" abre um pop-up que cuida do próprio foco.
 */
export function MenuDaMensagem({
  alvo,
  podeCopiar,
  podeCompartilhar,
  aoEscolher,
  aoFechar,
  aoDevolverFoco,
}: {
  alvo: AlvoDoMenu | null;
  podeCopiar: boolean;
  podeCompartilhar: boolean;
  aoEscolher: (acao: AcaoDoMenu) => void;
  aoFechar: () => void;
  aoDevolverFoco: () => void;
}) {
  const conteudoRef = useRef<HTMLDivElement>(null);
  // Por que o menu fechou: decide se o foco volta para a mensagem.
  const fechouPorCliqueFora = useRef(false);
  const acaoEscolhida = useRef<AcaoDoMenu | null>(null);

  // Aberto pelo teclado, o foco já cai no primeiro item (com o mouse, fica no próprio menu).
  // O Radix foca o menu ao montar; o item vem logo depois, no quadro seguinte.
  const viaTeclado = alvo?.via === "teclado";
  useEffect(() => {
    if (!alvo || !viaTeclado) return;
    const q = requestAnimationFrame(() => {
      conteudoRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus();
    });
    return () => cancelAnimationFrame(q);
  }, [alvo, viaTeclado]);

  function escolher(acao: AcaoDoMenu) {
    acaoEscolhida.current = acao;
    aoEscolher(acao);
  }

  return (
    <DropdownMenu
      modal={false}
      open={alvo !== null}
      onOpenChange={(aberto) => {
        if (!aberto) aoFechar();
      }}
    >
      <DropdownMenuTrigger asChild>
        {/* Âncora invisível no ponto do clique. Não recebe mouse nem foco. */}
        <span
          aria-hidden
          tabIndex={-1}
          style={{ position: "fixed", left: alvo?.x ?? 0, top: alvo?.y ?? 0, width: 1, height: 1, pointerEvents: "none", opacity: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={conteudoRef}
        align="start"
        side="bottom"
        sideOffset={2}
        aria-label="Ações da mensagem"
        className="min-w-[10.5rem]"
        onInteractOutside={() => {
          fechouPorCliqueFora.current = true;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const semDevolver = fechouPorCliqueFora.current || acaoEscolhida.current === "compartilhar";
          fechouPorCliqueFora.current = false;
          acaoEscolhida.current = null;
          if (!semDevolver) aoDevolverFoco();
        }}
      >
        <Item icone={<Copy />} desabilitado={!podeCopiar} aoSelecionar={() => escolher("copiar")}>
          Copiar
        </Item>
        <Item icone={<ListChecks />} aoSelecionar={() => escolher("selecionar")}>
          Selecionar
        </Item>
        <Item icone={<Share2 />} desabilitado={!podeCompartilhar} aoSelecionar={() => escolher("compartilhar")}>
          Compartilhar
        </Item>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Item({
  icone,
  desabilitado,
  aoSelecionar,
  children,
}: {
  icone: ReactNode;
  desabilitado?: boolean;
  aoSelecionar: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem disabled={desabilitado} onSelect={aoSelecionar}>
      <span aria-hidden className="text-ink-3">
        {icone}
      </span>
      {children}
    </DropdownMenuItem>
  );
}
