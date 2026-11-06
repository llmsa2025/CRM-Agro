"use client";

import { useState } from "react";
import { Bell, CalendarDays, LogOut, Moon, Sun, Users } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initialsOf } from "@/lib/format";
import { logoutAction } from "@/app/login/logout";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PushSettings } from "@/components/notificacoes/push-settings";
import { agendaGoogleVisivel, MinhaAgendaGoogleConta, useAgendaGoogleConta } from "@/components/agenda/minha-agenda-google-conta";

export type UsuarioSessao = { name?: string | null; email?: string | null; role?: string | null };

/** Mesmos rótulos de Configurações → Equipe (owner = o master, um só por time). */
const PAPEL: Record<string, string> = {
  owner: "Master",
  admin: "Administrador",
  member: "Membro",
  viewer: "Só leitura",
};

/**
 * Identidade da sessão no rodapé do menu lateral: avatar + nome + papel.
 * Clique abre o menu (tema, equipe, sair).
 */
export function UserMenu({ usuario, compact = false }: { usuario: UsuarioSessao; compact?: boolean }) {
  const { setTheme, resolvedTheme } = useTheme();
  const nome = usuario.name ?? usuario.email ?? "Usuário";
  const papel = usuario.role ? (PAPEL[usuario.role] ?? usuario.role) : null;
  // Avisos no navegador (Web Push) são da PESSOA, não da empresa: saíram de
  // Configurações (que nem todos veem) para o menu da conta (decisão de 28/09).
  const [avisosAbertos, setAvisosAbertos] = useState(false);
  // Agenda Google da pessoa: desconectar (revogar) de qualquer tela, mesmo sem
  // a Agenda/Integrações liberadas ou com papel "só leitura" (revisão do #169).
  const [agendaAberta, setAgendaAberta] = useState(false);
  // A2: quem não está liberado (GOOGLE_AGENDA_LIBERADOS) e não tem conexão nem vê o item.
  const agenda = useAgendaGoogleConta();

  return (
    <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Conta"
          className={`flex w-full items-center gap-2.5 rounded-md py-1.5 text-left transition-colors hover:bg-sidebar-active/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol/60 ${compact ? "justify-center px-0" : "px-2.5"}`}
          title={compact ? nome : undefined}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-100 text-caption font-semibold text-brand-500">
            {initialsOf(nome) || "?"}
          </span>
          {!compact && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-small font-medium text-sidebar-foreground">{nome}</span>
              <span className="block truncate text-caption text-sidebar-label">{papel ?? usuario.email}</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="text-body font-medium">{nome}</p>
          {usuario.email && <p className="truncate text-caption text-muted-foreground">{usuario.email}</p>}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/configuracoes">
            <Users className="h-4 w-4" />
            Equipe e configurações
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setAvisosAbertos(true)}>
          <Bell className="h-4 w-4" />
          Notificações
        </DropdownMenuItem>
        {agendaGoogleVisivel(agenda.estado) && (
          <DropdownMenuItem onSelect={() => setAgendaAberta(true)}>
            <CalendarDays className="h-4 w-4" />
            Minha Agenda Google
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
          {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {resolvedTheme === "dark" ? "Tema claro" : "Tema escuro"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <form action={logoutAction}>
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
          >
            <LogOut className="h-4 w-4" />
            Sair
          </button>
        </form>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={avisosAbertos} onOpenChange={setAvisosAbertos}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Notificações</DialogTitle>
        </DialogHeader>
        <PushSettings />
      </DialogContent>
    </Dialog>
    <Dialog open={agendaAberta} onOpenChange={setAgendaAberta}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Minha Agenda Google</DialogTitle>
        </DialogHeader>
        {agendaAberta ? <MinhaAgendaGoogleConta estado={agenda.estado} setEstado={agenda.setEstado} erro={agenda.erro} /> : null}
      </DialogContent>
    </Dialog>
    </>
  );
}
