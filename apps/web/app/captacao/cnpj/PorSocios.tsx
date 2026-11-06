"use client";

import { useEffect, useState } from "react";
import { Search, UserSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import type { CapturaAtual, PaginaDeCandidatos, SociosDaEmpresa, EstimativaDeBusca } from "@crmagro/core";
import { UFS_BR } from "@/lib/captacao-filtros";
import { textoDoCusto } from "@/lib/fonte-paga";
import {
  FORMULARIO_DE_SOCIO_VAZIO,
  MOTIVOS,
  formatarCpfDigitado,
  montarPedidoDeSocio,
  temNomeESobrenome,
  type FormularioDeSocio,
} from "@/lib/captacao-socios";
import type { botaoDaCaptura } from "@/lib/captacao-estado";
import {
  buscarCandidatosPorNomeAction,
  captureEmpresasDeSocioAction,
  estimarBuscaPorNomeAction,
  fontePagaDisponivelAction,
  municipiosDaUfAction,
  sociosDaEmpresaAction,
} from "../actions";
import { GiroDeBusca } from "../andamento-da-busca";
import { BuscarMais } from "./BuscarMais";

const selectClasse =
  "flex h-9 w-full rounded-md border border-line-strong bg-background px-3 py-1 text-body text-foreground focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50";

type Props = {
  botao: ReturnType<typeof botaoDaCaptura>;
  atual: CapturaAtual | null;
  setIniciando: (v: boolean) => void;
  recarregar: () => Promise<void>;
};

/**
 * Aba "Por sócios": empresas de uma PESSOA (por CPF, ou escolhendo um sócio já listado, ou achando a
 * pessoa pelo nome numa fonte paga) e sócios de uma EMPRESA. Tudo cai na mesma fila de revisão.
 */
export function PorSocios({ botao, atual, setIniciando, recarregar }: Props) {
  const [f, setF] = useState<FormularioDeSocio>(FORMULARIO_DE_SOCIO_VAZIO);
  const [cidades, setCidades] = useState<string[]>([]);
  const [escolhido, setEscolhido] = useState<string | null>(null); // "Maria S., ***.456.789-**": o sócio vindo da lista
  const set = <K extends keyof FormularioDeSocio>(k: K, v: FormularioDeSocio[K]) => setF((s) => ({ ...s, [k]: v }));
  const desativado = botao.desativado;

  useEffect(() => {
    if (!f.uf) return setCidades([]);
    let vivo = true;
    municipiosDaUfAction(f.uf)
      .then((n) => vivo && setCidades(n))
      .catch(() => vivo && setCidades([]));
    return () => {
      vivo = false;
    };
  }, [f.uf]);

  async function buscar() {
    if (desativado) return;
    const r = montarPedidoDeSocio(f);
    if (!r.ok) return toast.error("Confira os campos", { description: r.erro });
    setIniciando(true);
    const res = await captureEmpresasDeSocioAction(r.pedido);
    if (res.error) {
      setIniciando(false);
      return toast.error("Não deu para buscar", { description: res.error });
    }
    await recarregar();
    setIniciando(false);
    // O CPF digitado serve só para tirar a máscara: sai da tela assim que o pedido vai.
    setF((s) => ({ ...s, cpf: "" }));
    toast.success("Busca iniciada", { description: "As empresas aparecem na fila de revisão, com a confiança de cada uma." });
  }

  function usarSocio(nome: string, mascara: string, exibicao: string) {
    setF((s) => ({ ...s, nome, mascara, cpf: "", motivo: "socio_de_empresa" }));
    setEscolhido(`${nome}, CPF ${exibicao}`);
  }
  function limparSocio() {
    setF((s) => ({ ...s, mascara: null }));
    setEscolhido(null);
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="t-pessoa" className="space-y-3">
        <h3 id="t-pessoa" className="text-body font-medium">Empresas de uma pessoa</h3>
        <p className="text-caption text-muted-foreground">
          Acha as empresas em que a pessoa é sócia ou dona. O CPF serve só para achar e não é guardado. Quem tem o mesmo CPF mascarado pode ser
          outra pessoa, por isso o CRM Agro confere o nome e mostra a confiança de cada empresa.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="s-nome">Nome e sobrenome</Label>
            <Input id="s-nome" value={f.nome} onChange={(e) => set("nome", e.target.value)} placeholder="Como no cadastro da Receita" disabled={desativado} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-cpf">CPF</Label>
            {escolhido ? (
              <div className="flex h-9 items-center justify-between rounded-md border border-line bg-muted/30 px-3 text-body">
                <span className="truncate">{escolhido}</span>
                <button type="button" onClick={limparSocio} className="ml-2 text-caption text-muted-foreground hover:text-foreground" disabled={desativado}>
                  Trocar
                </button>
              </div>
            ) : (
              <Input id="s-cpf" inputMode="numeric" autoComplete="off" value={f.cpf} onChange={(e) => set("cpf", formatarCpfDigitado(e.target.value))} placeholder="000.000.000-00" disabled={desativado} />
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-uf">Estado</Label>
            <select id="s-uf" className={selectClasse} value={f.uf} onChange={(e) => setF((s) => ({ ...s, uf: e.target.value, cidade: "" }))} disabled={desativado}>
              <option value="">Todos</option>
              {UFS_BR.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="s-cidade">Cidade da empresa</Label>
            <Input id="s-cidade" list="s-cidades" value={f.cidade} onChange={(e) => set("cidade", e.target.value)} placeholder={f.uf ? "Todas do estado" : "Escolha o estado primeiro"} disabled={desativado || !f.uf} />
            <datalist id="s-cidades">
              {cidades.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="s-motivo">Por que você busca esta pessoa?</Label>
            <select id="s-motivo" className={selectClasse} value={f.motivo} onChange={(e) => set("motivo", e.target.value as FormularioDeSocio["motivo"])} disabled={desativado}>
              <option value="">Escolha um motivo</option>
              {MOTIVOS.map((m) => (
                <option key={m.valor} value={m.valor}>{m.rotulo}</option>
              ))}
            </select>
            <p className="text-caption text-muted-foreground">Use só para quem você já tem motivo para contatar. O motivo fica registrado na fila.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-body">
            <Checkbox checked={f.soAtivas} onCheckedChange={(v) => set("soAtivas", v === true)} disabled={desativado} />
            Só empresas ativas
          </label>
          <div className="flex items-center gap-3">
            {botao.andamento && (
              <span className="num text-caption text-muted-foreground" role="status" aria-live="polite">
                {botao.andamento}
              </span>
            )}
            <BuscarMais botao={botao} atual={atual} limite={Number(f.limite) || 100} setIniciando={setIniciando} recarregar={recarregar} />
            <Button type="button" onClick={buscar} disabled={desativado} aria-busy={desativado}>
              {desativado ? <GiroDeBusca /> : <Search className="mr-1.5 h-4 w-4" />}
              {botao.rotulo}
            </Button>
          </div>
        </div>
        <AcharPeloNome nome={f.nome} motivo={f.motivo} aoEscolher={usarSocio} desativado={desativado} />
      </section>

      <SociosDeUmaEmpresa aoEscolher={usarSocio} desativado={desativado} />
    </div>
  );
}

/** Sem CPF: acha a pessoa pelo nome numa fonte paga (só administrador, só com a fonte ligada), mostrando o custo antes. */
function AcharPeloNome({ nome, motivo, aoEscolher, desativado }: { nome: string; motivo: FormularioDeSocio["motivo"]; aoEscolher: (nome: string, mascara: string, exibicao: string) => void; desativado: boolean }) {
  const [disp, setDisp] = useState<{ pode: boolean; ligada: boolean } | null>(null);
  const [est, setEst] = useState<EstimativaDeBusca | null>(null);
  const [pagina, setPagina] = useState<PaginaDeCandidatos | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    void fontePagaDisponivelAction().then(setDisp);
  }, []);
  // Mudou o nome: a estimativa e a lista de antes não valem mais.
  useEffect(() => {
    setEst(null);
    setPagina(null);
  }, [nome]);

  if (!disp?.pode) return null; // quem não é administrador nem vê a opção
  if (!disp.ligada) {
    return (
      <p className="text-caption text-muted-foreground">
        Sem o CPF, achar a pessoa só pelo nome precisa de uma fonte paga. Ela está desligada: ligue em Integrações, Fontes de dados.
      </p>
    );
  }

  async function estimar() {
    if (!temNomeESobrenome(nome)) return toast.error("Informe nome e sobrenome acima.");
    setOcupado(true);
    const r = await estimarBuscaPorNomeAction({ nome });
    setOcupado(false);
    if (r.error || !r.estimativa) return toast.error("Não deu para estimar", { description: r.error });
    setEst(r.estimativa);
  }
  async function confirmar() {
    if (!est) return;
    if (!motivo) return toast.error("Diga por que você busca esta pessoa.");
    setOcupado(true);
    const r = await buscarCandidatosPorNomeAction({ nome, motivo, creditosConfirmados: est.creditos });
    setOcupado(false);
    if (r.error || !r.pagina) return toast.error("Não deu para buscar", { description: r.error });
    setPagina(r.pagina);
    setEst(null);
    if (!r.pagina.candidatos.length) toast.info("Ninguém com esse nome na fonte.");
  }

  return (
    <div className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-muted-foreground">Sem o CPF: achar a pessoa pelo nome (fonte paga, só administrador).</p>
        <Button type="button" variant="outline" size="sm" onClick={estimar} disabled={ocupado || desativado}>
          <UserSearch className="mr-1.5 h-3.5 w-3.5" /> Ver custo
        </Button>
      </div>
      {est && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-body" role="status">
          <span>
            {est.dentroDoTeto
              ? `A busca custa ${textoDoCusto(est.creditos, est.centavos)}.`
              : `A busca custa ${est.creditos} créditos e o teto por busca é ${est.tetoCreditosPorBusca}.`}
          </span>
          <Button type="button" size="sm" onClick={confirmar} disabled={ocupado || !est.dentroDoTeto || !est.fonteLigada}>
            Confirmar e buscar
          </Button>
        </div>
      )}
      {pagina && pagina.candidatos.length > 0 && (
        <ul className="divide-y divide-line">
          {pagina.candidatos.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="text-body font-medium">{c.nome}</div>
                <div className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
                  {[c.faixaEtaria ? `${c.faixaEtaria} anos` : null, c.empresas.slice(0, 2).map((e) => e.nome).join(", ")].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!c.cpfMascarado || desativado}
                onClick={() => c.cpfMascarado && aoEscolher(c.nome, c.cpfMascarado, `***.${c.cpfMascarado.slice(3, 6)}.${c.cpfMascarado.slice(6, 9)}-**`)}
              >
                Usar esta pessoa
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** O contrário: dado o CNPJ de uma empresa, quem são os sócios (e dali, as outras empresas de cada um). */
function SociosDeUmaEmpresa({ aoEscolher, desativado }: { aoEscolher: (nome: string, mascara: string, exibicao: string) => void; desativado: boolean }) {
  const [cnpj, setCnpj] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [dados, setDados] = useState<SociosDaEmpresa | null>(null);

  async function ver() {
    if (!cnpj.trim()) return toast.error("Cole o CNPJ da empresa.");
    setCarregando(true);
    const r = await sociosDaEmpresaAction(cnpj);
    setCarregando(false);
    if (r.error || !r.dados) return toast.error("Não deu para ver os sócios", { description: r.error });
    setDados(r.dados);
  }

  return (
    <section aria-labelledby="t-empresa" className="space-y-3 border-t border-line pt-4">
      <h3 id="t-empresa" className="text-body font-medium">Sócios de uma empresa</h3>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="e-cnpj">CNPJ</Label>
          <Input id="e-cnpj" value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="00.000.000/0000-00" />
        </div>
        <Button type="button" variant="outline" onClick={ver} disabled={carregando}>
          {carregando ? <GiroDeBusca /> : null}
          Ver sócios
        </Button>
      </div>
      {dados && (
        <div className="space-y-1">
          <p className="text-caption text-muted-foreground">
            {dados.razaoSocial ?? dados.cnpj}: {dados.socios.length === 0 ? "nenhum sócio na fonte." : `${dados.socios.length} ${dados.socios.length === 1 ? "sócio" : "sócios"}.`}
          </p>
          <ul className="divide-y divide-line">
            {dados.socios.map((s, i) => (
              <li key={`${s.nome}-${i}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="text-body font-medium">{s.nome}</div>
                  <div className="num text-caption text-muted-foreground">
                    {[s.qualificacao, s.faixaEtaria ? `${s.faixaEtaria} anos` : null, s.cpfExibicao ? `CPF ${s.cpfExibicao}` : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <Button type="button" variant="ghost" size="sm" disabled={!s.mascara || desativado} onClick={() => s.mascara && s.cpfExibicao && aoEscolher(s.nome, s.mascara, s.cpfExibicao)}>
                  Ver empresas dele
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
