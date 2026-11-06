"use client";

import { AvatarDoContato } from "./AvatarDoContato";
import { InteresseBadge } from "@/components/ui/interesse-badge";
import { cn } from "@/lib/utils";
import { initialsOf, formatWhen, formatPhone } from "@/lib/format";
import type { ConversationListItem } from "@crmagro/core";

/**
 * Lista de conversas (v2): linhas com hairline, avatar 40px (foto do WhatsApp
 * ou iniciais), nome + hora na mesma linha, prévia em tinta-2, interesse como
 * ponto + texto. Não lida = nome em peso 600 e contador discreto. Clicar na
 * linha, foto inclusa, abre a conversa; a foto grande abre pelo cabeçalho dela.
 */
export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  channel,
}: {
  conversations: ConversationListItem[];
  selectedId: string | null;
  onSelect: (c: ConversationListItem) => void;
  channel?: string;
}) {
  const email = channel === "email";
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {conversations.map((c) => {
        const active = c.id === selectedId;
        const unread = c.unreadCount > 0;
        const preview = email
          ? c.lastMessage?.conteudo || "(sem assunto)"
          : c.lastMessage
            ? `${c.lastMessage.direcao === "out" ? "Você: " : ""}${c.lastMessage.conteudo ?? ""}`
            : "Nenhuma mensagem ainda";
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "flex w-full items-start gap-3 rounded-md px-3 py-3 text-left transition-colors hover:bg-accent/60",
              active && "bg-accent",
            )}
          >
            <AvatarDoContato
              conversationId={c.id}
              nome={c.displayName.startsWith("+") ? formatPhone(c.displayName) : c.displayName}
              iniciais={c.displayName.startsWith("+") ? "#" : initialsOf(c.displayName) || "?"}
              comFoto={c.canal === "whatsapp"}
              className="h-10 w-10"
              fallbackClassName="text-small"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn("num truncate text-body text-foreground", unread ? "font-semibold" : "font-medium")}>
                  {c.displayName.startsWith("+") ? formatPhone(c.displayName) : c.displayName}
                </span>
                <span className={cn("num shrink-0 text-caption", unread ? "font-medium text-foreground" : "text-ink-3")}>
                  {c.lastMessage ? formatWhen(c.lastMessage.createdAt) : ""}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={cn("truncate text-small", unread ? "text-foreground" : "text-ink-2")}>{preview}</span>
                {unread && (
                  <span className="num flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-brand-500 px-1 text-[11px] font-medium text-white">
                    {c.unreadCount}
                  </span>
                )}
              </div>
              {c.contact && c.contact.interesse !== "nao_avaliado" && (
                <div className="mt-1">
                  <InteresseBadge interesse={c.contact.interesse} className="text-caption" />
                </div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
