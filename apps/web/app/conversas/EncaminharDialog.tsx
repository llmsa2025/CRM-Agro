"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPhone } from "@/lib/format";
import { MAX_DESTINOS_ENCAMINHAR, resumoDoEncaminhamento, rotuloDaMensagem, type ResumoDoEncaminhamento } from "@/lib/menu-mensagem";
import type { DestinoDeEncaminhamento, MessageDTO, ResultadoEncaminhamento } from "@crmagro/core";
import { encaminharMensagensAction, listarDestinosEncaminharAction } from "./actions";

/** Segunda linha de cada conversa: telefone ou e-mail, e o número/caixa por onde a mensagem sai. */
function detalheDoDestino(d: DestinoDeEncaminhamento): string {
  const contato = d.numero ? formatPhone(d.numero) : (d.email ?? "");
  return [contato, d.conta].filter(Boolean).join(" · ");
}

/**
 * Pop-up "Compartilhar": a pessoa escolhe até 5 conversas do MESMO canal da
 * mensagem (a lista já vem filtrada pelo servidor, com busca por nome ou número)
 * e envia. Falha de um destino não derruba os outros: o pop-up mostra, por
 * conversa, o que saiu e o que não saiu.
 *
 * `mensagens` = o que está sendo compartilhado; `null` = fechado.
 */
export function EncaminharDialog({
  mensagens,
  conversationId,
  canal,
  aoFechar,
  aoConcluir,
  aoDevolverFoco,
}: {
  mensagens: MessageDTO[] | null;
  conversationId: string;
  canal: string;
  /** Fechou sem enviar nada. */
  aoFechar: () => void;
  /** Fechou depois de enviar (ao menos uma conversa recebeu): a tela sai do modo de seleção. */
  aoConcluir: () => void;
  aoDevolverFoco: () => void;
}) {
  const aberto = mensagens !== null;
  const [busca, setBusca] = useState("");
  const [itens, setItens] = useState<DestinoDeEncaminhamento[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [erroDaLista, setErroDaLista] = useState<string | null>(null);
  const [escolhidos, setEscolhidos] = useState<Map<string, DestinoDeEncaminhamento>>(new Map());
  const [enviando, setEnviando] = useState(false);
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ dados: ResultadoEncaminhamento; resumo: ResumoDoEncaminhamento } | null>(null);
  // Resposta velha (busca anterior) nunca sobrescreve a mais nova.
  const pedidoAtual = useRef(0);

  // Abriu: começa do zero.
  useEffect(() => {
    if (!aberto) return;
    setBusca("");
    setItens([]);
    setErroDaLista(null);
    setEscolhidos(new Map());
    setEnviando(false);
    setErroGeral(null);
    setResultado(null);
  }, [aberto]);

  // Lista de destinos (com um respiro de 250 ms na digitação).
  useEffect(() => {
    if (!aberto || resultado) return;
    const pedido = ++pedidoAtual.current;
    setCarregando(true);
    const t = setTimeout(async () => {
      const r = await listarDestinosEncaminharAction(conversationId, busca);
      if (pedido !== pedidoAtual.current) return;
      setCarregando(false);
      if (r.error) {
        setErroDaLista(r.error);
        setItens([]);
      } else {
        setErroDaLista(null);
        setItens(r.items ?? []);
      }
    }, busca ? 250 : 0);
    return () => clearTimeout(t);
  }, [aberto, busca, conversationId, resultado]);

  const cheio = escolhidos.size >= MAX_DESTINOS_ENCAMINHAR;

  const alternar = useCallback((d: DestinoDeEncaminhamento) => {
    setEscolhidos((atual) => {
      const novo = new Map(atual);
      if (novo.has(d.id)) novo.delete(d.id);
      else if (novo.size < MAX_DESTINOS_ENCAMINHAR) novo.set(d.id, d);
      return novo;
    });
  }, []);

  async function enviar() {
    if (!mensagens || escolhidos.size === 0 || enviando) return;
    setEnviando(true);
    setErroGeral(null);
    const r = await encaminharMensagensAction({ messageIds: mensagens.map((m) => m.id), destinoIds: [...escolhidos.keys()] });
    setEnviando(false);
    if (!r.resultado) {
      setErroGeral(r.error ?? "Não foi possível encaminhar. Tente de novo.");
      return;
    }
    const resumo = resumoDoEncaminhamento(r.resultado, mensagens.length);
    if (resumo.tipo === "ok") {
      toast.success(resumo.titulo);
      if (resumo.aviso) toast.warning(resumo.aviso);
      aoConcluir();
      return;
    }
    // Deu problema em algum destino: mostra o que aconteceu com cada um.
    setResultado({ dados: r.resultado, resumo });
  }

  function fechar() {
    if (enviando) return;
    if (resultado && resultado.dados.destinos.some((d) => d.enviadas > 0)) aoConcluir();
    else aoFechar();
  }

  const primeira = mensagens?.[0];
  const resumoDaMensagem = useMemo(() => {
    if (!mensagens || !primeira) return "";
    const base = rotuloDaMensagem(primeira);
    return mensagens.length > 1 ? `${base} e mais ${mensagens.length - 1}` : base;
  }, [mensagens, primeira]);
  const canalTexto = canal === "email" ? "e-mail" : "WhatsApp";

  return (
    <Dialog open={aberto} onOpenChange={(o) => !o && fechar()}>
      <DialogContent
        className="max-w-md gap-4"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          aoDevolverFoco();
        }}
      >
        <DialogHeader>
          <DialogTitle>{mensagens && mensagens.length > 1 ? `Compartilhar ${mensagens.length} mensagens` : "Compartilhar mensagem"}</DialogTitle>
          <DialogDescription>
            {resultado ? resultado.resumo.titulo : `Escolha até ${MAX_DESTINOS_ENCAMINHAR} conversas de ${canalTexto}.`}
          </DialogDescription>
        </DialogHeader>

        {resultado ? (
          <div role="status" className="space-y-3">
            <ul className="space-y-2">
              {resultado.dados.destinos.map((d) => (
                <li key={d.conversationId} className="flex items-start gap-2 text-body">
                  {d.erro ? (
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger-500" aria-label="Não enviada" />
                  ) : (
                    <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-success-500" aria-label="Enviada" />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{d.nome}</span>
                    {d.erro ? <span className="block text-small text-ink-2">{d.erro}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            {resultado.resumo.aviso ? <p className="text-small text-warning-500">{resultado.resumo.aviso}</p> : null}
            <DialogFooter>
              <Button onClick={fechar}>Fechar</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            {resumoDaMensagem ? (
              <p className="truncate rounded-md border border-line bg-muted/40 px-3 py-2 text-small text-ink-2" title={resumoDaMensagem}>
                {resumoDaMensagem}
              </p>
            ) : null}

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
              <Input
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar por nome ou número"
                aria-label="Buscar conversa"
                className="pl-9"
                disabled={enviando}
                autoComplete="off"
              />
            </div>

            {escolhidos.size > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Conversas escolhidas">
                {[...escolhidos.values()].map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => alternar(d)}
                      disabled={enviando}
                      aria-label={`Tirar ${d.nome}`}
                      className="inline-flex items-center gap-1 rounded-full border border-line bg-accent px-2.5 py-0.5 text-small text-foreground hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                    >
                      <span className="max-w-[9rem] truncate">{d.nome}</span>
                      <X className="h-3 w-3 text-ink-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="max-h-64 min-h-[8rem] overflow-y-auto rounded-md border border-line" aria-busy={carregando}>
              {erroDaLista ? (
                <p role="alert" className="p-4 text-small text-danger-500">
                  {erroDaLista}
                </p>
              ) : carregando && itens.length === 0 ? (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : itens.length === 0 ? (
                <p className="p-4 text-center text-small text-ink-2">
                  {busca.trim() ? `Nenhuma conversa encontrada para “${busca.trim()}”.` : `Você ainda não tem outras conversas de ${canalTexto} com histórico.`}
                </p>
              ) : (
                <ul>
                  {itens.map((d) => {
                    const marcado = escolhidos.has(d.id);
                    const id = `destino-${d.id}`;
                    return (
                      <li key={d.id}>
                        <label
                          htmlFor={id}
                          className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-accent/60 has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60"
                        >
                          <Checkbox id={id} checked={marcado} disabled={enviando || (cheio && !marcado)} onCheckedChange={() => alternar(d)} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body text-foreground">{d.nome}</span>
                            <span className="num block truncate text-caption text-ink-3">{detalheDoDestino(d)}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {erroGeral ? (
              <p role="alert" className="text-small text-danger-500">
                {erroGeral}
              </p>
            ) : null}
            <p className="text-caption text-ink-3" aria-live="polite">
              {enviando
                ? "Enviando. Os envios saem com uma pausa entre eles."
                : cheio
                  ? `Limite de ${MAX_DESTINOS_ENCAMINHAR} conversas por vez.`
                  : `${escolhidos.size} de ${MAX_DESTINOS_ENCAMINHAR} escolhidas`}
            </p>

            <DialogFooter>
              <Button variant="ghost" onClick={fechar} disabled={enviando}>
                Cancelar
              </Button>
              <Button onClick={() => void enviar()} disabled={escolhidos.size === 0 || enviando}>
                {enviando ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden /> Enviando
                  </>
                ) : (
                  "Enviar"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
