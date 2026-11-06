"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Search, UserSearch } from "lucide-react";
import type { EstimativaDeBusca, PropostaDaPessoa } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { UFS_BR } from "@/lib/captacao-filtros";
import { MOTIVOS } from "@/lib/captacao-socios";
import { dataCurta, rotuloDaConfianca } from "@/lib/enriquecer-empresa";
import { textoDoCusto } from "@/lib/fonte-paga";
import {
  contatosMarcadosDeSaida,
  empresasMarcadasDeSaida,
  formatarCpf,
  iesMarcadasDeSaida,
  montarPedidoDaPessoa,
  textoDoAplicarPessoa,
  textoDoResultadoPessoa,
  type FormularioDaPessoa,
} from "@/lib/enriquecer-pessoa";
import {
  aplicarPropostaDaPessoaAction,
  consultarIeDaPessoaAction,
  estimarIeDaPessoaAction,
  fontePagaDisponivelParaPessoaAction,
  propostaDaPessoaAction,
} from "../actions";

const selectClasse =
  "flex h-9 w-full rounded-md border border-line-strong bg-background px-3 py-1 text-body text-foreground focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-50";

type Props = {
  contactId: string;
  /** Dados do cadastro para preencher o formulário. O CPF do cadastro já aparece na ficha, então entra preenchido aqui também. */
  inicial: { nome: string; cidade: string | null; estado: string | null; email: string | null; telefone: string | null; cpf: string | null };
};

/** Botão "Enriquecer pessoa" da ficha do contato + o diálogo. */
export function EnriquecerPessoa({ contactId, inicial }: Props) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setAberto(true)}>
        <UserSearch className="mr-1 h-3.5 w-3.5" /> Enriquecer pessoa
      </Button>
      {aberto && <Dialogo contactId={contactId} inicial={inicial} onClose={() => setAberto(false)} />}
    </>
  );
}

function Dialogo({ contactId, inicial, onClose }: Props & { onClose: () => void }) {
  const router = useRouter();
  const temCpf = Boolean(inicial.cpf);
  const [f, setF] = useState<FormularioDaPessoa>({
    cpf: formatarCpf(inicial.cpf ?? ""),
    nome: inicial.nome,
    cidade: inicial.cidade ?? "",
    uf: inicial.estado ?? "",
    email: inicial.email ?? "",
    telefone: inicial.telefone ?? "",
  });
  const set = <K extends keyof FormularioDaPessoa>(k: K, v: FormularioDaPessoa[K]) => setF((s) => ({ ...s, [k]: v }));
  const [buscando, setBuscando] = useState(false);
  const [proposta, setProposta] = useState<PropostaDaPessoa | null>(null);
  const [empresasSel, setEmpresasSel] = useState<Set<string>>(new Set());
  const [iesSel, setIesSel] = useState<Set<string>>(new Set());
  const [contatosSel, setContatosSel] = useState<Set<string>>(new Set());
  const [guardarCpf, setGuardarCpf] = useState(false);
  const [aplicando, aplicar] = useTransition();

  async function buscar(incluirInativas = false) {
    const r = montarPedidoDaPessoa(f, temCpf, { incluirInativas });
    if (!r.ok) return toast.error("Confira os campos", { description: r.erro });
    setBuscando(true);
    const res = await propostaDaPessoaAction(contactId, r.pedido);
    setBuscando(false);
    if (res.error || !res.proposta) return toast.error("Não deu para buscar", { description: res.error });
    setProposta(res.proposta);
    setEmpresasSel(empresasMarcadasDeSaida(res.proposta.empresas));
    setContatosSel(contatosMarcadosDeSaida(res.proposta.contatos));
    setIesSel(new Set());
  }

  function confirmar() {
    if (!proposta) return;
    aplicar(async () => {
      const cpf = f.cpf.replace(/\D/g, "");
      const r = await aplicarPropostaDaPessoaAction(contactId, proposta.id, { empresas: [...empresasSel], ies: [...iesSel], contatos: [...contatosSel], guardarCpf: guardarCpf && cpf.length === 11 ? cpf : null });
      if (r.error || !r.resultado) {
        toast.error("Não deu para aplicar", { description: r.error });
        return;
      }
      toast.success(textoDoResultadoPessoa(r.resultado));
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Enriquecer pessoa</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-caption text-muted-foreground">
            Acha as empresas ativas em que a pessoa é sócia ou dona e sugere telefone, e-mail e endereço que a Receita guarda nelas. O CPF serve só
            para a busca. Quem tem o mesmo CPF mascarado pode ser outra pessoa, por isso o CRM Agro confere o nome.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-cpf">CPF</Label>
              <Input id="p-cpf" inputMode="numeric" autoComplete="off" value={f.cpf} onChange={(e) => set("cpf", formatarCpf(e.target.value))} placeholder="000.000.000-00" />
              {temCpf && <p className="text-caption text-muted-foreground">CPF do cadastro. Pode trocar para buscar outro.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-nome">Nome e sobrenome</Label>
              <Input id="p-nome" value={f.nome} onChange={(e) => set("nome", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-uf">Estado</Label>
              <select id="p-uf" className={selectClasse} value={f.uf} onChange={(e) => set("uf", e.target.value)}>
                <option value="">Todos</option>
                {UFS_BR.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-cidade">Cidade</Label>
              <Input id="p-cidade" value={f.cidade} onChange={(e) => set("cidade", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-email">E-mail</Label>
              <Input id="p-email" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-fone">Telefone</Label>
              <Input id="p-fone" inputMode="tel" value={f.telefone} onChange={(e) => set("telefone", e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => buscar(false)} disabled={buscando}>
              {buscando ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Search className="mr-1.5 h-4 w-4" />}
              {buscando ? "Buscando…" : "Buscar empresas"}
            </Button>
          </div>

          {proposta && (
            <Resultado
              proposta={proposta}
              setProposta={setProposta}
              empresasSel={empresasSel}
              setEmpresasSel={setEmpresasSel}
              contatosSel={contatosSel}
              setContatosSel={setContatosSel}
              mostrarInativas={() => buscar(true)}
              buscando={buscando}
              iesSel={iesSel}
              setIesSel={setIesSel}
              cpfDigitado={f.cpf.replace(/\D/g, "")}
              ufInicial={f.uf}
            />
          )}
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <label className={"flex items-center gap-2 text-caption " + (f.cpf.replace(/\D/g, "").length === 11 && !temCpf ? "" : "invisible")}>
            <Checkbox checked={guardarCpf} onCheckedChange={(v) => setGuardarCpf(v === true)} />
            Guardar o CPF no contato (cifrado)
          </label>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={aplicando}>Cancelar</Button>
            {proposta && (
              <Button onClick={confirmar} disabled={aplicando || (empresasSel.size + iesSel.size + contatosSel.size === 0 && !guardarCpf)}>
                {aplicando ? "Aplicando…" : textoDoAplicarPessoa(empresasSel.size, iesSel.size, contatosSel.size)}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function alternarEm(set: Set<string>, id: string): Set<string> {
  const n = new Set(set);
  if (n.has(id)) n.delete(id);
  else n.add(id);
  return n;
}

function Resultado(p: {
  proposta: PropostaDaPessoa;
  setProposta: (x: PropostaDaPessoa) => void;
  empresasSel: Set<string>;
  setEmpresasSel: (s: Set<string>) => void;
  contatosSel: Set<string>;
  setContatosSel: (s: Set<string>) => void;
  mostrarInativas: () => void;
  buscando: boolean;
  iesSel: Set<string>;
  setIesSel: (s: Set<string>) => void;
  cpfDigitado: string;
  ufInicial: string;
}) {
  const { proposta } = p;
  return (
    <div className="space-y-4 border-t border-line pt-4">
      {proposta.avisos.map((a) => (
        <p key={a} className="flex items-start gap-2 rounded-md border border-warning-500/30 bg-warning-100 p-2 text-caption text-warning-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {a}
        </p>
      ))}
      {proposta.buscou.cpfExibicao && <p className="num text-caption text-muted-foreground">Buscado com o CPF {proposta.buscou.cpfExibicao}.</p>}

      {proposta.inativasOcultas > 0 && !proposta.buscou.incluiuInativas && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          {proposta.inativasOcultas} {proposta.inativasOcultas === 1 ? "empresa inativa na Receita ficou" : "empresas inativas na Receita ficaram"} de fora.
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={p.mostrarInativas} disabled={p.buscando}>Mostrar também as inativas</Button>
        </p>
      )}

      {proposta.empresas.length > 0 && (
        <section aria-labelledby="r-empresas" className="space-y-1">
          <h3 id="r-empresas" className="text-body font-medium">Empresas em que é sócio ou dono</h3>
          <ul className="divide-y divide-line rounded-md border">
            {proposta.empresas.map((e) => (
              <li key={e.id} className="flex items-start gap-3 p-3">
                <Checkbox
                  checked={p.empresasSel.has(e.id)}
                  disabled={e.jaVinculada}
                  onCheckedChange={() => p.setEmpresasSel(alternarEm(p.empresasSel, e.id))}
                  aria-label={e.jaVinculada ? `${e.razaoSocial ?? e.cnpj} já está vinculada` : `Vincular ${e.razaoSocial ?? e.cnpj}`}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-body font-medium [overflow-wrap:anywhere]">{e.razaoSocial ?? e.cnpj}</span>
                    <Badge variant={e.ativa ? "success" : "destructive"}>{e.ativa ? "Ativa" : "Inativa"}</Badge>
                    {e.jaVinculada ? <Badge variant="outline-muted">Já vinculada</Badge> : <Badge variant="outline-muted">{rotuloDaConfianca(e.confianca)}</Badge>}
                  </div>
                  <div className="num text-caption text-muted-foreground">
                    {[e.cnpj, [e.cidade, e.uf].filter(Boolean).join("/"), e.situacao, e.qualificacao].filter(Boolean).join(" · ")}
                  </div>
                  <div className="num text-caption text-muted-foreground">
                    {e.fonteRotulo}, {dataCurta(e.consultadoEm)}
                    {e.observacao ? ` · ${e.observacao}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <DadosDeContato dados={proposta.contatos} sel={p.contatosSel} setSel={p.setContatosSel} />

      <InscricaoDeProdutor {...p} />
    </div>
  );
}

const ROTULO_DO_DADO = { telefone: "Celular", email: "E-mail", endereco: "Endereço" } as const;

/** Telefone, e-mail e endereço que a Receita guarda na empresa. Só vem marcado o que é de empresário individual ou MEI. */
function DadosDeContato(p: { dados: PropostaDaPessoa["contatos"]; sel: Set<string>; setSel: (s: Set<string>) => void }) {
  if (p.dados.length === 0) return null;
  return (
    <section aria-labelledby="r-contatos" className="space-y-1">
      <h3 id="r-contatos" className="text-body font-medium">Telefone, e-mail e endereço</h3>
      <p className="text-caption text-muted-foreground">
        A Receita guarda estes dados na empresa, não na pessoa. Em empresário individual e MEI costumam ser dela; em sociedade, quase sempre
        da empresa. Marque só o que fizer sentido para este contato.
      </p>
      <ul className="divide-y divide-line rounded-md border">
        {p.dados.map((d) => (
          <li key={d.id} className="flex items-start gap-3 p-3">
            <Checkbox
              checked={p.sel.has(d.id)}
              disabled={d.jaNoCadastro}
              onCheckedChange={() => p.setSel(alternarEm(p.sel, d.id))}
              aria-label={`Acrescentar ${ROTULO_DO_DADO[d.tipo].toLowerCase()} ${d.exibicao}`}
              className="mt-1"
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="num text-body font-medium [overflow-wrap:anywhere]">{d.exibicao}</span>
                <Badge variant="outline-muted">{ROTULO_DO_DADO[d.tipo]}</Badge>
                {d.jaNoCadastro && <Badge variant="outline-muted">{d.tipo === "endereco" ? "Contato já tem endereço" : "Já no cadastro"}</Badge>}
                {!d.jaNoCadastro && d.provavelPessoal && <Badge variant="info">Empresário individual ou MEI</Badge>}
              </div>
              <div className="num text-caption text-muted-foreground">
                Da empresa {d.empresa} · {d.fonteRotulo}, {dataCurta(d.consultadoEm)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** IE de produtor rural: consulta PAGA, só para administrador, com a fonte ligada, custo mostrado antes. */
function InscricaoDeProdutor(p: { proposta: PropostaDaPessoa; setProposta: (x: PropostaDaPessoa) => void; iesSel: Set<string>; setIesSel: (s: Set<string>) => void; cpfDigitado: string; ufInicial: string }) {
  const [disp, setDisp] = useState<{ pode: boolean; ligada: boolean } | null>(null);
  const [uf, setUf] = useState(p.ufInicial);
  const [motivo, setMotivo] = useState<(typeof MOTIVOS)[number]["valor"] | "">("");
  const [est, setEst] = useState<EstimativaDeBusca | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    void fontePagaDisponivelParaPessoaAction().then(setDisp);
  }, []);

  if (!disp?.pode) return null;
  if (!disp.ligada) {
    return <p className="text-caption text-muted-foreground">A inscrição estadual de produtor rural precisa de uma fonte paga. Ela está desligada: ligue em Integrações, Fontes de dados.</p>;
  }
  const cpfOk = p.cpfDigitado.length === 11;

  async function ver() {
    if (!cpfOk) return toast.error("Digite o CPF completo acima para consultar a inscrição.");
    if (!uf) return toast.error("Escolha o estado da inscrição.");
    setOcupado(true);
    const r = await estimarIeDaPessoaAction();
    setOcupado(false);
    if (r.error || !r.estimativa) return toast.error("Não deu para estimar", { description: r.error });
    setEst(r.estimativa);
  }
  async function consultar() {
    if (!est || !motivo) return toast.error("Diga por que você consulta esta pessoa.");
    setOcupado(true);
    const r = await consultarIeDaPessoaAction(p.proposta.id, { cpf: p.cpfDigitado, uf, motivo, creditosConfirmados: est.creditos });
    setOcupado(false);
    if (r.error || !r.proposta) return toast.error("Não deu para consultar", { description: r.error });
    p.setProposta(r.proposta);
    p.setIesSel(iesMarcadasDeSaida(r.proposta.ies));
    setEst(null);
  }

  return (
    <section aria-labelledby="r-ie" className="space-y-2 rounded-md border border-line p-3">
      <h3 id="r-ie" className="text-body font-medium">Inscrição estadual de produtor rural</h3>
      <p className="text-caption text-muted-foreground">
        Consulta paga, uma por estado. O fornecedor recebe o CPF consultado. Use só para quem você já tem motivo para contatar.
      </p>
      <div className="grid gap-2 sm:grid-cols-[96px_1fr_auto]">
        <select className={selectClasse} value={uf} onChange={(e) => setUf(e.target.value)} aria-label="Estado da inscrição" disabled={ocupado}>
          <option value="">UF</option>
          {UFS_BR.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
        <select className={selectClasse} value={motivo} onChange={(e) => setMotivo(e.target.value as typeof motivo)} aria-label="Motivo da consulta" disabled={ocupado}>
          <option value="">Motivo da consulta</option>
          {MOTIVOS.map((m) => (
            <option key={m.valor} value={m.valor}>{m.rotulo}</option>
          ))}
        </select>
        <Button type="button" variant="outline" size="sm" onClick={ver} disabled={ocupado}>Ver custo</Button>
      </div>
      {est && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-body" role="status">
          <span>{est.dentroDoTeto ? `A consulta custa ${textoDoCusto(est.creditos, est.centavos)}.` : `A consulta custa ${est.creditos} créditos e o teto por busca é ${est.tetoCreditosPorBusca}.`}</span>
          <Button type="button" size="sm" onClick={consultar} disabled={ocupado || !est.dentroDoTeto || !est.fonteLigada}>Confirmar e consultar</Button>
        </div>
      )}
      {p.proposta.ies.length > 0 && (
        <ul className="divide-y divide-line">
          {p.proposta.ies.map((i) => (
            <li key={i.id} className="flex items-start gap-3 py-2">
              <Checkbox checked={p.iesSel.has(i.id)} onCheckedChange={() => p.setIesSel(alternarEm(p.iesSel, i.id))} aria-label={`Vincular a inscrição ${i.numero}`} className="mt-1" />
              <div className="min-w-0 flex-1">
                <div className="num text-body font-medium">{i.numero} · {i.uf}</div>
                <div className="num text-caption text-muted-foreground">
                  {[i.habilitada ? "Habilitada" : "Não habilitada", i.situacao, i.tipo].filter(Boolean).join(" · ")}
                </div>
                <div className="num text-caption text-muted-foreground">{i.fonteRotulo}, {dataCurta(i.consultadoEm)} · {rotuloDaConfianca(i.confianca)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
