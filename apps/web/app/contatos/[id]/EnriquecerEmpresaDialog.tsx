"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { PropostaDaEmpresa, ItemDaProposta } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { alternar, dataCurta, rotuloDaConfianca, selecaoInicial, textoDoAplicar, trocasMarcadas } from "@/lib/enriquecer-empresa";
import { aplicarPropostaAction, propostaDaEmpresaAction } from "../actions";

type Props = { contactId: string; companyId: string; companyNome: string; onClose: () => void };

/**
 * "Enriquecer empresa": busca no CNPJ (e no site, se a empresa tem) e MOSTRA o que achou, com a fonte e a
 * data de cada dado. Nada é gravado antes do OK: campo vazio vem marcado, troca de valor que já existe
 * só se a pessoa marcar.
 */
export function EnriquecerEmpresaDialog({ contactId, companyId, companyNome, onClose }: Props) {
  const router = useRouter();
  const [proposta, setProposta] = useState<PropostaDaEmpresa | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [selecao, setSelecao] = useState<Set<string>>(new Set());
  const [guardarPublicos, setGuardarPublicos] = useState(true);
  const [aplicando, aplicar] = useTransition();

  useEffect(() => {
    let vivo = true;
    void propostaDaEmpresaAction(contactId, companyId).then((r) => {
      if (!vivo) return;
      if (r.error || !r.proposta) return setErro(r.error ?? "Não deu para consultar agora.");
      setProposta(r.proposta);
      setSelecao(selecaoInicial(r.proposta.itens));
    });
    return () => {
      vivo = false;
    };
  }, [contactId, companyId]);

  const itens = useMemo(() => proposta?.itens ?? [], [proposta]);
  const novos = itens.filter((i) => i.acao !== "igual");
  const iguais = itens.filter((i) => i.acao === "igual");
  const trocas = trocasMarcadas(selecao, itens);
  const temPublicos = Boolean(proposta && (proposta.dadosPublicos.length || proposta.socios.length));

  function confirmar() {
    if (!proposta) return;
    aplicar(async () => {
      const r = await aplicarPropostaAction(contactId, proposta.id, [...selecao], guardarPublicos && temPublicos);
      if (r.error) {
        toast.error("Não deu para aplicar", { description: r.error });
        return;
      }
      const n = r.aplicados?.length ?? 0;
      toast.success(n ? `${n} ${n === 1 ? "campo preenchido" : "campos preenchidos"}` : "Dados públicos guardados", {
        description: r.ignorados?.length ? "Alguns campos foram preenchidos por alguém nesse meio tempo e ficaram como estão." : undefined,
      });
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enriquecer {companyNome}</DialogTitle>
        </DialogHeader>

        {!proposta && !erro && (
          <p className="flex items-center gap-2 py-6 text-body text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Consultando as fontes…
          </p>
        )}
        {erro && <p className="py-4 text-body text-destructive" role="alert">{erro}</p>}

        {proposta && (
          <div className="space-y-5">
            {proposta.avisos.map((a) => (
              <p key={a} className="flex items-start gap-2 rounded-md border border-warning-500/30 bg-warning-100 p-2 text-caption text-warning-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {a}
              </p>
            ))}

            {novos.length === 0 && <p className="text-body text-muted-foreground">Nenhum dado novo. {iguais.length ? "Tudo o que as fontes trouxeram já está na empresa." : ""}</p>}
            {novos.length > 0 && (
              <ul className="divide-y divide-line rounded-md border">
                {novos.map((i) => (
                  <LinhaDoItem key={i.id} item={i} marcado={selecao.has(i.id)} aoAlternar={() => setSelecao((s) => alternar(s, itens, i.id))} />
                ))}
              </ul>
            )}
            {trocas > 0 && (
              <p className="text-caption text-muted-foreground">
                {trocas} {trocas === 1 ? "valor marcado troca" : "valores marcados trocam"} o que já está na empresa.
              </p>
            )}
            {iguais.length > 0 && (
              <p className="text-caption text-muted-foreground">
                Já estão iguais: {iguais.map((i) => i.rotulo.toLowerCase()).join(", ")}.
              </p>
            )}

            {temPublicos && (
              <section className="space-y-2">
                <label className="flex items-center gap-2 text-body font-medium">
                  <Checkbox checked={guardarPublicos} onCheckedChange={(v) => setGuardarPublicos(v === true)} />
                  Guardar os dados públicos da Receita na ficha da empresa
                </label>
                <dl className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-2">
                  {proposta.dadosPublicos.map((d) => (
                    <div key={d.rotulo} className="min-w-0">
                      <dt className="text-caption text-muted-foreground">{d.rotulo}</dt>
                      <dd className="[overflow-wrap:anywhere]">{d.valor}</dd>
                    </div>
                  ))}
                </dl>
                {proposta.socios.length > 0 && (
                  <div>
                    <p className="text-caption text-muted-foreground">Sócios ({proposta.dadosPublicos[0] ? `${proposta.dadosPublicos[0].fonteRotulo}, ${dataCurta(proposta.dadosPublicos[0].consultadoEm)}` : "Receita"})</p>
                    <ul className="text-body">
                      {proposta.socios.map((s, i) => (
                        <li key={`${s.nome}-${i}`}>
                          {s.nome}
                          <span className="num text-caption text-muted-foreground">
                            {[s.qualificacao, s.faixaEtaria ? `${s.faixaEtaria} anos` : null, s.cpfExibicao ? `CPF ${s.cpfExibicao}` : null].filter(Boolean).length
                              ? ` · ${[s.qualificacao, s.faixaEtaria ? `${s.faixaEtaria} anos` : null, s.cpfExibicao ? `CPF ${s.cpfExibicao}` : null].filter(Boolean).join(" · ")}`
                              : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={aplicando}>Cancelar</Button>
          {proposta && (
            <Button onClick={confirmar} disabled={aplicando || (selecao.size === 0 && !(guardarPublicos && temPublicos))}>
              {aplicando ? "Aplicando…" : textoDoAplicar(selecao.size, guardarPublicos && temPublicos)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinhaDoItem({ item, marcado, aoAlternar }: { item: ItemDaProposta; marcado: boolean; aoAlternar: () => void }) {
  return (
    <li className="flex items-start gap-3 p-3">
      <Checkbox checked={marcado} onCheckedChange={aoAlternar} aria-label={`${item.rotulo}: ${item.valor}`} className="mt-1" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-caption text-muted-foreground">{item.rotulo}</span>
          {item.acao === "trocar" && <Badge variant="outline-muted">Troca o valor atual</Badge>}
          <Badge variant="outline-muted">{rotuloDaConfianca(item.confianca)}</Badge>
        </div>
        <div className="text-body [overflow-wrap:anywhere]">
          {item.acao === "trocar" && item.atual ? (
            <>
              <span className="text-muted-foreground line-through">{item.atual}</span> {item.valor}
            </>
          ) : (
            item.valor
          )}
        </div>
        <div className="num text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {item.fonteRotulo}, {dataCurta(item.consultadoEm)}
          {item.fonteUrl ? ` · ${item.fonteUrl}` : ""}
          {item.observacao ? ` · ${item.observacao}` : ""}
        </div>
      </div>
    </li>
  );
}
