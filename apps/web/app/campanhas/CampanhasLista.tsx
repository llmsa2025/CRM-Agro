"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { CampaignDTO } from "@crmagro/core";
import { BotaoCompartilhar } from "@/components/escopo/botao-compartilhar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { createCampaignAction, compartilharCampanhaAction } from "./actions";
import { STATUS_CAMPANHA, numeros, origemDaLista, pct, quando } from "./rotulos";

const ABAS = [
  { v: "todas", label: "Todas", filtro: () => true },
  { v: "andamento", label: "Em andamento", filtro: (c: CampaignDTO) => c.status === "sending" || c.status === "paused" },
  { v: "agendadas", label: "Agendadas", filtro: (c: CampaignDTO) => c.status === "scheduled" },
  { v: "concluidas", label: "Concluídas", filtro: (c: CampaignDTO) => c.status === "done" || c.status === "canceled" },
  { v: "rascunhos", label: "Rascunhos", filtro: (c: CampaignDTO) => c.status === "draft" },
] as const;

export function CampanhasLista({
  campanhas,
  podeEditar,
  eu = null,
  veTudo = false,
}: {
  campanhas: CampaignDTO[];
  podeEditar: boolean;
  /** F4: quem pede e se vê o time todo (decide o botão "Compartilhar"). */
  eu?: string | null;
  veTudo?: boolean;
}) {
  const router = useRouter();
  const [aba, setAba] = useState<(typeof ABAS)[number]["v"]>("todas");
  const [novaOpen, setNovaOpen] = useState(false);
  const [nome, setNome] = useState("");
  const [pending, start] = useTransition();

  const enviando = campanhas.filter((c) => c.status === "sending").length;
  const agendadas = campanhas.filter((c) => c.status === "scheduled").length;

  // Faixa de números: agregados do que foi enviado (todas as campanhas).
  const agregados = useMemo(() => {
    let enviadas = 0;
    let responderam = 0;
    let alcancados = 0;
    let campanhasNoMes = 0;
    const inicioMes = new Date();
    inicioMes.setDate(1);
    inicioMes.setHours(0, 0, 0, 0);
    for (const c of campanhas) {
      const x = numeros(c.contagem);
      enviadas += x.enviadas;
      responderam += x.responderam;
      if (c.iniciadaEm && new Date(c.iniciadaEm) >= inicioMes) {
        alcancados += x.enviadas;
        campanhasNoMes += 1;
      }
    }
    return { enviadas, responderam, alcancados, campanhasNoMes, taxa: pct(responderam, enviadas) };
  }, [campanhas]);

  const visiveis = campanhas.filter(ABAS.find((a) => a.v === aba)!.filtro);
  const mes = new Intl.DateTimeFormat("pt-BR", { month: "long", timeZone: "America/Sao_Paulo" }).format(new Date());

  function criar() {
    const n = nome.trim();
    if (!n) return;
    start(async () => {
      const res = await createCampaignAction(n);
      if (res.ok) {
        setNovaOpen(false);
        setNome("");
        router.push(`/campanhas/${res.campaign.id}`);
      } else toast.error("Não deu para criar a campanha", { description: res.error });
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Campanhas"
        subtitle={`${campanhas.length} ${campanhas.length === 1 ? "campanha" : "campanhas"}${enviando ? ` · ${enviando} enviando` : ""}${agendadas ? ` · ${agendadas} ${agendadas === 1 ? "agendada" : "agendadas"}` : ""}`}
        actions={podeEditar ? <Button onClick={() => setNovaOpen(true)}>Nova campanha</Button> : undefined}
      />

      <section aria-label="Resumo" className="grid grid-cols-1 border-y border-line sm:grid-cols-3">
        <div className="flex flex-col gap-1.5 py-4 pr-6 sm:border-r sm:border-line">
          <div className="text-small text-ink-2">Taxa de resposta</div>
          <div className="num font-serif text-num">{agregados.taxa}%</div>
          <div className="num text-caption text-ink-2">
            {agregados.responderam} respostas em {agregados.enviadas} enviadas
          </div>
        </div>
        <div className="flex flex-col gap-1.5 py-4 sm:border-r sm:border-line sm:px-6">
          <div className="text-small text-ink-2">Respostas para tratar</div>
          <div className="num font-serif text-num">{agregados.responderam}</div>
          <Link href="/conversas" className="text-caption font-medium text-brand-500 hover:underline">
            Abrir em Conversas →
          </Link>
        </div>
        <div className="flex flex-col gap-1.5 py-4 sm:px-6">
          <div className="text-small text-ink-2">Contatos alcançados, {mes}</div>
          <div className="num font-serif text-num">{agregados.alcancados}</div>
          <div className="num text-caption text-ink-2">
            em {agregados.campanhasNoMes} {agregados.campanhasNoMes === 1 ? "campanha" : "campanhas"}
          </div>
        </div>
      </section>

      <div>
        <div role="tablist" className="flex gap-6 border-b border-line">
          {ABAS.map((a) => {
            const n = campanhas.filter(a.filtro).length;
            return (
              <button
                key={a.v}
                type="button"
                role="tab"
                aria-selected={aba === a.v}
                onClick={() => setAba(a.v)}
                className={cn(
                  "-mb-px flex h-10 items-center gap-1.5 border-b-2 text-body transition-colors",
                  aba === a.v ? "border-foreground font-medium text-foreground" : "border-transparent text-ink-2 hover:text-foreground",
                )}
              >
                {a.label}
                <span className="num text-ink-3">{n}</span>
              </button>
            );
          })}
        </div>

        {campanhas.length === 0 ? (
          <EmptyState
            title="Nenhuma campanha ainda"
            description="Uma campanha manda uma mensagem para uma lista, no ritmo que não bloqueia o número. Quem responder cai no fluxo Pós-resposta."
            action={podeEditar ? <Button onClick={() => setNovaOpen(true)}>Nova campanha</Button> : undefined}
          />
        ) : visiveis.length === 0 ? (
          <p className="py-10 text-center text-body text-ink-2">Nada nesta aba.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campanha</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[260px]">Progresso</TableHead>
                <TableHead numeric>Responderam</TableHead>
                <TableHead>Próximo passo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visiveis.map((c) => {
                const st = STATUS_CAMPANHA[c.status];
                const x = numeros(c.contagem);
                const alvo = x.naFila + x.enviadas;
                return (
                  <TableRow key={c.id}>
                    <TableCell className="h-[68px]">
                      <Link href={`/campanhas/${c.id}`} className="text-body font-medium text-foreground hover:underline">
                        {c.nome}
                      </Link>
                      <div className="num mt-0.5 flex flex-wrap items-center gap-x-2 text-small text-ink-2">
                        <span>{x.total > 0 ? `${x.total} contatos · ${origemDaLista(c)}` : c.status === "draft" ? "falta montar a lista" : origemDaLista(c)}</span>
                        <BotaoCompartilhar
                          compartilhado={c.compartilhado}
                          podeMudar={podeEditar && (veTudo || (eu !== null && c.createdById === eu))}
                          rotulo="campanha"
                          acao={(v) => compartilharCampanhaAction(c.id, v)}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusDot tone={st.tone}>{st.label}</StatusDot>
                    </TableCell>
                    <TableCell>
                      {c.status === "draft" ? (
                        <span className="text-small text-ink-2">Etapa {Math.min(c.etapa, 4)} de 4</span>
                      ) : (
                        <div className="flex items-center gap-3">
                          <Progress value={pct(x.enviadas, alvo)} className="w-36" />
                          <span className="num text-small text-ink-2">
                            {x.enviadas}/{alvo}
                          </span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell numeric>
                      {x.responderam > 0 ? (
                        <span className="num">
                          <span className="font-medium">{x.responderam}</span>
                          <span className="text-ink-2"> · {pct(x.responderam, x.enviadas)}%</span>
                        </span>
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {c.status === "draft" ? (
                        <Link href={`/campanhas/${c.id}`} className="text-small font-medium text-brand-500 hover:underline">
                          Continuar →
                        </Link>
                      ) : c.status === "scheduled" ? (
                        <span className="num text-small text-ink-2">começa {quando(c.iniciaEm, true)}</span>
                      ) : c.status === "sending" ? (
                        <span className="num text-small text-ink-2">
                          {c.terminoPrevisto ? `termina ${quando(c.terminoPrevisto)}` : x.naFila > 0 ? `${x.naFila} na fila` : "terminando"}
                        </span>
                      ) : c.status === "paused" ? (
                        <span className="text-small text-ink-2">{c.pausadoMotivo ?? "pausada"}</span>
                      ) : (
                        <span className="num text-small text-ink-3">{c.concluidaEm ? quando(c.concluidaEm) : "—"}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog open={novaOpen} onOpenChange={setNovaOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nova campanha</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="nome-campanha">Nome</Label>
            <Input
              id="nome-campanha"
              autoFocus
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && criar()}
              placeholder="Ex.: Produtores MT · safra 26/27"
            />
            <p className="text-caption text-ink-3">Depois: a lista, a mensagem e o ritmo, em 4 passos.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNovaOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={criar} disabled={pending || !nome.trim()}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Criar e montar a lista
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
