"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatPhone } from "@/lib/format";
import { buscarContatosParaVinculoAction, vincularDraftsAction, type ContatoParaVinculo } from "../actions";

/**
 * "Vincular a contato": a empresa é de um contato que a pessoa já trabalha. Ela não vira contato
 * (não entra na lista de Contatos), fica na ficha dele, em Empresas, e o trabalho segue por ele.
 * As selecionadas vão todas para o mesmo contato. Dá para desfazer na própria ficha (desvincular).
 */
export function VincularAContato({ ids, onFeito }: { ids: string[]; onFeito: () => void }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [contatos, setContatos] = useState<ContatoParaVinculo[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [escolhido, setEscolhido] = useState<ContatoParaVinculo | null>(null);
  const [vinculando, setVinculando] = useState(false);

  // Abre limpo: sem busca e sem contato escolhido de uma vez anterior.
  useEffect(() => {
    if (!aberto) return;
    setBusca("");
    setEscolhido(null);
  }, [aberto]);

  // Busca por nome, empresa ou número; espera a pessoa parar de digitar.
  useEffect(() => {
    if (!aberto) return;
    let ativo = true;
    setCarregando(true);
    const t = setTimeout(() => {
      buscarContatosParaVinculoAction(busca.trim() || undefined)
        .then((r) => ativo && setContatos(r))
        .catch(() => ativo && setContatos([]))
        .finally(() => ativo && setCarregando(false));
    }, 250);
    return () => {
      ativo = false;
      clearTimeout(t);
    };
  }, [aberto, busca]);

  const descricao =
    ids.length === 1
      ? "A empresa fica na ficha do contato que você escolher, em Empresas. Ela não vira contato e não aparece na lista de Contatos."
      : `As ${ids.length} empresas ficam na ficha do contato que você escolher, em Empresas. Elas não viram contatos e não aparecem na lista de Contatos.`;

  async function vincular() {
    if (!escolhido) return;
    setVinculando(true);
    const r = await vincularDraftsAction(ids, escolhido.id);
    setVinculando(false);
    if (r.error) return toast.error("Não foi possível vincular", { description: r.error });
    const n = r.vinculados ?? 0;
    toast.success(`${n === 1 ? "1 empresa vinculada" : `${n} empresas vinculadas`} a ${escolhido.nome}`, {
      description: r.pulados ? `${r.pulados} ${r.pulados === 1 ? "ficou" : "ficaram"} de fora (já saíram da fila)` : undefined,
      action: { label: "Abrir contato", onClick: () => router.push(`/contatos/${escolhido.id}`) },
    });
    setAberto(false);
    onFeito();
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setAberto(true)}>
        <Link2 className="mr-1.5 h-4 w-4" /> Vincular a contato
      </Button>
      <Dialog open={aberto} onOpenChange={(v) => !vinculando && setAberto(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Vincular a um contato</DialogTitle>
            <DialogDescription>{descricao}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <div className="relative">
              <Search aria-hidden="true" className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por nome, empresa ou número"
                className="pl-8"
                aria-label="Buscar contato por nome, empresa ou número"
                autoFocus
              />
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto" role="listbox" aria-label="Contatos">
              {carregando ? (
                <p className="py-3 text-center text-caption text-muted-foreground">Carregando…</p>
              ) : contatos.length === 0 ? (
                <p className="py-3 text-center text-caption text-muted-foreground">Nenhum contato encontrado.</p>
              ) : (
                contatos.map((c) => {
                  const marcado = escolhido?.id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={marcado}
                      onClick={() => setEscolhido(c)}
                      className={
                        "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-body hover:bg-muted/50 " +
                        (marcado ? "border-brand-600 bg-brand-100/30" : "")
                      }
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{c.nome}</span>
                        {c.empresa && <span className="block truncate text-caption text-muted-foreground">{c.empresa}</span>}
                      </span>
                      <span className="shrink-0 text-caption text-muted-foreground">{c.telefone ? formatPhone(c.telefone) : ""}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)} disabled={vinculando}>
              Cancelar
            </Button>
            <Button onClick={vincular} disabled={!escolhido || vinculando}>
              {vinculando && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              {escolhido ? `Vincular a ${escolhido.nome}` : "Vincular"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
