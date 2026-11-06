"use client";

/**
 * Paleta de comandos (Ctrl K / Cmd K) — navegação e ações rápidas.
 *
 * Abre pelo atalho ou pela busca da barra superior (evento global). Navegação
 * por setas, Enter seleciona, Esc fecha.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Search } from "lucide-react";
import { NavIcon, type NavIconName } from "@/components/nav-icons";
import { telaDoCaminho } from "@/lib/telas";

type Cmd = { icon: NavIconName; label: string; href?: string; group: string; hint?: string };

const COMMANDS: Cmd[] = [
  { icon: "painel", label: "Painel", href: "/", group: "Ir para" },
  { icon: "atividades", label: "Atividades", href: "/atividades", group: "Ir para" },
  { icon: "conversas", label: "Conversas", href: "/conversas", group: "Ir para" },
  { icon: "ligacoes", label: "Ligações", href: "/ligacoes", group: "Ir para" },
  { icon: "agenda", label: "Agenda", href: "/agenda", group: "Ir para" },
  { icon: "contatos", label: "Contatos", href: "/contatos", group: "Ir para" },
  { icon: "captacao", label: "Captação", href: "/captacao", group: "Ir para" },
  { icon: "funis", label: "Funis", href: "/funis", group: "Ir para" },
  { icon: "fluxos", label: "Fluxos", href: "/fluxos", group: "Ir para" },
  { icon: "integracoes", label: "Integrações", href: "/integracoes", group: "Ir para" },
  { icon: "configuracoes", label: "Configurações", href: "/configuracoes", group: "Ir para" },
  { icon: "contatos", label: "Novo contato", href: "/contatos/novo", group: "Ações" },
  { icon: "contatos", label: "Importar contatos", href: "/contatos/importar", group: "Ações" },
  { icon: "conversas", label: "Nova conversa", href: "/conversas?nova=1", group: "Ações" },
  { icon: "agenda", label: "Novo compromisso", href: "/agenda?novo=1", group: "Ações" },
];

const GROUPS = ["Ir para", "Ações"];

/**
 * `telas`: as telas liberadas da pessoa (F2b) — null = todas. O Ctrl K só
 * oferece o que a pessoa pode abrir (antes levava a /sem-acesso).
 */
export function CommandMenu({ telas = null }: { telas?: string[] | null }) {
  const [open, setOpen] = useState(false);
  const pode = (href?: string) => {
    if (!telas || !href) return true;
    const t = telaDoCaminho(href.split("?")[0] ?? href);
    return !t || telas.includes(t);
  };
  const buscaEmContatos = pode("/contatos");
  const [q, setQ] = useState("");
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onAbrir = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("crmagro:busca:abrir", onAbrir);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("crmagro:busca:abrir", onAbrir);
    };
  }, []);

  const run = (cmd: Cmd) => {
    setOpen(false);
    if (cmd.href) router.push(cmd.href);
  };

  // Busca livre: se o texto não casa com um comando, procura nos contatos.
  const buscarContatos = () => {
    const termo = q.trim();
    if (!termo || !buscaEmContatos) return;
    setOpen(false);
    router.push(`/contatos?search=${encodeURIComponent(termo)}`);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQ("");
      }}
      label="Buscar e navegar"
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[14vh]"
    >
      <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-[560px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-popover">
        <div className="flex items-center gap-2.5 border-b px-4">
          <Search className="h-4 w-4 shrink-0 text-ink-3" />
          <Command.Input
            value={q}
            onValueChange={setQ}
            placeholder="Buscar contato, empresa, número ou tela…"
            className="h-12 flex-1 bg-transparent text-body outline-none placeholder:text-ink-3"
            onKeyDown={(e) => {
              if (e.key === "Enter" && q.trim()) {
                // Enter com texto que não selecionou item → busca em contatos.
                const selecionado = document.querySelector("[cmdk-item][data-selected='true']");
                if (!selecionado) buscarContatos();
              }
            }}
          />
          <kbd className="rounded border px-1.5 py-px text-caption text-ink-3">Esc</kbd>
        </div>
        <Command.List className="max-h-[360px] overflow-y-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-body text-ink-2">
            Nenhuma tela ou ação com esse nome.
            {q.trim() && buscaEmContatos && (
              <button
                type="button"
                onClick={buscarContatos}
                className="mt-2 block w-full text-small font-medium text-brand-500 hover:underline"
              >
                Buscar “{q.trim()}” em Contatos
              </button>
            )}
          </Command.Empty>
          {GROUPS.map((g) => (
            <Command.Group
              key={g}
              heading={g}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-ink-3"
            >
              {COMMANDS.filter((c) => c.group === g && pode(c.href)).map((c) => (
                <Command.Item
                  key={c.label}
                  value={c.label}
                  onSelect={() => run(c)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-body text-foreground data-[selected=true]:bg-accent"
                >
                  <NavIcon name={c.icon} className="text-ink-3" />
                  <span className="flex-1">{c.label}</span>
                  {c.hint && <span className="text-caption text-ink-3">{c.hint}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
