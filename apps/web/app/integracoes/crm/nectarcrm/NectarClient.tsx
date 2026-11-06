"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { DiagnosticoConexao, NectarStatusDTO } from "@crmagro/core";
import { LogoFerramenta } from "@/components/brand-icons";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionHeader } from "@/components/ui/page-header";
import { StatusDot } from "@/components/ui/status-dot";
import {
  AVISO_AUTOMACOES_NECTAR,
  estadoNoHub,
  linhaDoFunil,
  linhasDoDiagnostico,
  mensagemDaCredencial,
  textoDoIpSaida,
  tomDaCredencial,
} from "@/lib/nectar/conexao";
import type { ResultadoNectar } from "./actions";

type Acao = () => Promise<ResultadoNectar>;

/**
 * Tela de conexão do Nectar CRM (admin): cola o token da API, "Salvar e testar"
 * e o diagnóstico. O token fica cifrado no servidor e NUNCA volta para cá: a
 * tela só recebe os 4 últimos caracteres. As ações chegam por props.
 */
export function NectarClient({
  status,
  podeEditar,
  salvar,
  testar,
  remover,
}: {
  status: NectarStatusDTO;
  podeEditar: boolean;
  salvar: (token: string) => Promise<ResultadoNectar>;
  testar: Acao;
  remover: Acao;
}) {
  const router = useRouter();
  const [atual, setAtual] = useState(status);
  const [diagnostico, setDiagnostico] = useState<DiagnosticoConexao | null>(null);
  const [token, setToken] = useState("");
  const [trocando, setTrocando] = useState(false);
  const [ocupado, setOcupado] = useState<"salvar" | "testar" | "remover" | null>(null);
  const [confirmarRemover, setConfirmarRemover] = useState(false);

  // O servidor recarrega (router.refresh) depois de cada ação: acompanha o que ele mandou.
  useEffect(() => setAtual(status), [status]);

  const estado = estadoNoHub(atual);
  const mostrarCampo = !atual.configurado || trocando;

  /** Roda uma ação, mostra o erro em toast e devolve o resultado (ou null se deu erro). */
  async function rodar(qual: "salvar" | "testar" | "remover", acao: Acao): Promise<ResultadoNectar | null> {
    setOcupado(qual);
    const r = await acao().catch(() => ({ error: "Não deu para falar com o Nectar." }) as ResultadoNectar);
    setOcupado(null);
    if (r.error) {
      toast.error(r.error);
      return null;
    }
    return r;
  }

  /** Depois de salvar ou testar: guarda o estado e o diagnóstico e avisa o resultado da credencial. */
  function aplicar(r: ResultadoNectar) {
    if (r.status) setAtual(r.status);
    if (r.diagnostico) {
      setDiagnostico(r.diagnostico);
      const texto = mensagemDaCredencial(r.diagnostico.credencial);
      if (r.diagnostico.credencial === "ok") toast.success(texto);
      else toast.error(texto);
    }
    router.refresh();
  }

  async function aoSalvar() {
    const r = await rodar("salvar", () => salvar(token));
    if (!r) return;
    setToken("");
    setTrocando(false);
    aplicar(r);
  }

  async function aoTestar() {
    const r = await rodar("testar", testar);
    if (r) aplicar(r);
  }

  async function aoRemover() {
    const r = await rodar("remover", remover);
    if (!r) return;
    setConfirmarRemover(false);
    setDiagnostico(null);
    setAtual({ ...atual, configurado: false, finalDoToken: null, status: "disconnected" });
    toast.success("Conexão com o Nectar removida");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="t-conexao" className="max-w-2xl">
        <SectionHeader id="t-conexao" title="Conexão" />
        <Card className="mt-4">
          <CardContent className="flex flex-col gap-4 p-5">
            <div className="flex items-center gap-4">
              <LogoFerramenta id="nectar" />
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium">Nectar CRM</div>
                <div className="text-small text-ink-2">
                  {atual.configurado && atual.finalDoToken ? `Token configurado ${atual.finalDoToken}` : "Nenhum token configurado"}
                </div>
              </div>
              <StatusDot tone={estado.tone}>{estado.label}</StatusDot>
            </div>

            {!podeEditar ? (
              <p className="text-small text-ink-2">Só administradores conectam o Nectar.</p>
            ) : (
              <>
                {mostrarCampo ? (
                  <div className="grid gap-1.5">
                    <Label htmlFor="token-nectar">Token da API do Nectar</Label>
                    <Input
                      id="token-nectar"
                      name="token-nectar"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      disabled={ocupado !== null}
                    />
                    <p className="text-small text-ink-2">
                      No Nectar: Configurações → Integrações → API → Gerar token. Gere com um usuário administrador: o CRM Agro vê e grava o que esse usuário pode
                      ver e gravar.
                    </p>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  {mostrarCampo ? (
                    <Button onClick={aoSalvar} disabled={ocupado !== null || token.trim() === ""}>
                      {ocupado === "salvar" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      Salvar e testar
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => setTrocando(true)} disabled={ocupado !== null}>
                      Trocar token
                    </Button>
                  )}
                  {atual.configurado ? (
                    <Button variant="outline" onClick={aoTestar} disabled={ocupado !== null}>
                      {ocupado === "testar" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      Testar de novo
                    </Button>
                  ) : null}
                  {trocando ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setTrocando(false);
                        setToken("");
                      }}
                      disabled={ocupado !== null}
                    >
                      Cancelar
                    </Button>
                  ) : null}
                  {atual.configurado ? (
                    <Button variant="ghost" onClick={() => setConfirmarRemover(true)} disabled={ocupado !== null}>
                      Remover
                    </Button>
                  ) : null}
                </div>
              </>
            )}

            <p className="text-small text-ink-3">{textoDoIpSaida(atual.ipSaida)}</p>
          </CardContent>
        </Card>
      </section>

      {diagnostico ? <Diagnostico d={diagnostico} /> : null}

      <Dialog open={confirmarRemover} onOpenChange={setConfirmarRemover}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remover a conexão com o Nectar?</DialogTitle>
          </DialogHeader>
          <p className="text-body text-ink-2">Remover a conexão com o Nectar? O token é apagado do CRM Agro. Nada é apagado no Nectar.</p>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirmarRemover(false)} disabled={ocupado !== null}>
              Manter conexão
            </Button>
            <Button variant="outline" className="text-danger-500 hover:text-danger-700" onClick={aoRemover} disabled={ocupado !== null}>
              {ocupado === "remover" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Remover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Resultado do "Testar": credencial, funis, Leadboard, usuários, filas, etiqueta, campos e formatos. */
function Diagnostico({ d }: { d: DiagnosticoConexao }) {
  const linhas = linhasDoDiagnostico(d);
  const credencialOk = d.credencial === "ok";
  return (
    <section aria-labelledby="t-diagnostico" className="max-w-2xl">
      <SectionHeader id="t-diagnostico" title="Diagnóstico" />
      <div className="flex items-center gap-4 border-b border-line py-3.5">
        <div className="min-w-0 flex-1 text-body font-medium">Token</div>
        <StatusDot tone={tomDaCredencial(d.credencial)}>{mensagemDaCredencial(d.credencial)}</StatusDot>
      </div>

      {credencialOk ? (
        <>
          <div className="border-b border-line py-3.5">
            <div className="text-body font-medium">Funis de vendas</div>
            {d.funisVendas.length === 0 ? (
              <p className="pt-1 text-small text-ink-2">Nenhum funil de vendas.</p>
            ) : (
              <ul className="flex flex-col gap-2 pt-2">
                {d.funisVendas.map((f) => {
                  const l = linhaDoFunil(f);
                  return (
                    <li key={f.id} className="text-small">
                      <span className="font-medium text-foreground">{l.nome}</span>
                      <span className="text-ink-2"> {l.etapas}</span>
                      {l.indisponivel ? <span className="text-warning-700"> (indisponível: {l.indisponivel})</span> : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {linhas.map((l) => (
            <div key={l.id} className="border-b border-line py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="text-body font-medium">{l.rotulo}</div>
                <div className="max-w-[28rem] text-right text-small text-ink-2">{l.texto}</div>
              </div>
              {l.id === "leadboard" && d.leadboard === "tem" && d.funisPreVenda.length > 0 ? (
                <ul className="flex flex-col gap-2 pt-2">
                  {d.funisPreVenda.map((f) => {
                    const fl = linhaDoFunil(f);
                    return (
                      <li key={f.id} className="text-small">
                        <span className="font-medium text-foreground">{fl.nome}</span>
                        <span className="text-ink-2"> {fl.etapas}</span>
                        {fl.indisponivel ? <span className="text-warning-700"> (indisponível: {fl.indisponivel})</span> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {l.itens ? (
                <ul className="num flex flex-col gap-1 pt-2 text-small text-ink-2">
                  {l.itens.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}

          <p className="pt-4 text-small text-ink-2">{AVISO_AUTOMACOES_NECTAR}</p>
        </>
      ) : null}
    </section>
  );
}
