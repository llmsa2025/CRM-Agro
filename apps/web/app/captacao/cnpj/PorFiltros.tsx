"use client";

import { useEffect, useState } from "react";
import { Search, Plus, Info, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CapturaAtual } from "@crmagro/core";
import {
  CNAES_SUGERIDOS,
  FORMULARIO_VAZIO,
  PORTES_BUSCA,
  UFS_BR,
  cnaeFormatado,
  dominioAtivo,
  lerCnaes,
  limiteDaBusca,
  montarPedido,
  type FormularioDeFiltros,
} from "@/lib/captacao-filtros";
import type { botaoDaCaptura } from "@/lib/captacao-estado";
import { captureCnpjsPorFiltroAction, municipiosDaUfAction, pararBuscaPorFiltroAction } from "../actions";
import { BuscarMais } from "./BuscarMais";
import { GiroDeBusca } from "../andamento-da-busca";
import { ListaDeCnaes } from "./ListaDeCnaes";
import { SeletorDeCidades } from "./SeletorDeCidades";

const selectClasse =
  "flex h-9 w-full rounded-md border border-line-strong bg-background px-3 py-1 text-body text-foreground focus-visible:border-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-50";

type Props = {
  botao: ReturnType<typeof botaoDaCaptura>;
  atual: CapturaAtual | null;
  /** Segura o botão enquanto a action não respondeu. */
  setIniciando: (v: boolean) => void;
  /** Relê o estado da busca no servidor. */
  recarregar: () => Promise<void>;
};

/**
 * Aba "Por filtros": CNAE, estado, cidade, porte, capital social, situação e data de abertura.
 * A busca roda no servidor e os resultados caem na MESMA fila de revisão da aba "Por CNPJ".
 */
export function PorFiltros({ botao, atual, setIniciando, recarregar }: Props) {
  const [f, setF] = useState<FormularioDeFiltros>(FORMULARIO_VAZIO);
  const [cidades, setCidades] = useState<string[]>([]);
  const set = <K extends keyof FormularioDeFiltros>(k: K, v: FormularioDeFiltros[K]) => setF((s) => ({ ...s, [k]: v }));

  // Cidades do estado escolhido, para a caixa de sugestões (o servidor confere o nome de novo).
  useEffect(() => {
    if (!f.uf) {
      setCidades([]);
      return;
    }
    let vivo = true;
    municipiosDaUfAction(f.uf)
      .then((n) => vivo && setCidades(n))
      .catch(() => vivo && setCidades([]));
    return () => {
      vivo = false;
    };
  }, [f.uf]);

  const cnaesLidos = lerCnaes(f.cnaesTexto).codigos;
  function alternarCnae(codigo: string) {
    const novos = cnaesLidos.includes(codigo) ? cnaesLidos.filter((c) => c !== codigo) : [...cnaesLidos, codigo];
    set("cnaesTexto", novos.map(cnaeFormatado).join(", "));
  }
  function alternarPorte(p: "micro" | "pequeno" | "demais") {
    set("portes", f.portes.includes(p) ? f.portes.filter((x) => x !== p) : [...f.portes, p]);
  }

  async function buscar() {
    if (botao.desativado) return;
    const r = montarPedido(f);
    if (!r.ok) return toast.error("Confira os filtros", { description: r.erro });
    setIniciando(true);
    const res = await captureCnpjsPorFiltroAction(r.pedido);
    if (res.error) {
      setIniciando(false);
      return toast.error("Não deu para buscar", { description: res.error });
    }
    await recarregar();
    setIniciando(false);
    toast.success("Busca iniciada", { description: "As empresas aparecem na fila de revisão conforme forem achadas." });
  }

  async function parar() {
    const r = await pararBuscaPorFiltroAction();
    if (r.error) return toast.error("Não deu para parar", { description: r.error });
    toast.success("Pedido enviado", { description: "A busca para em instantes. O que já veio fica na fila." });
  }

  const desativado = botao.desativado;
  // O filtro de palavra no e-mail só vale com a caixa marcada E com palavra; ele implica "Só com e-mail".
  const dominioValendo = dominioAtivo(f);
  const exigeEmail = f.soComEmail || dominioValendo;
  const buscaEmail = f.completarContato || exigeEmail;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="f-cnae">CNAE (atividade da empresa)</Label>
          <Input
            id="f-cnae"
            value={f.cnaesTexto}
            onChange={(e) => set("cnaesTexto", e.target.value)}
            placeholder="0115-6/00, 0151-2/01 (até 10, separados por vírgula)"
            disabled={desativado}
          />
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {CNAES_SUGERIDOS.slice(0, 12).map((c) => {
              const ligado = cnaesLidos.includes(c.codigo);
              return (
                <button
                  key={c.codigo}
                  type="button"
                  onClick={() => alternarCnae(c.codigo)}
                  disabled={desativado}
                  aria-pressed={ligado}
                  title={`${cnaeFormatado(c.codigo)} ${c.nome}`}
                  className={
                    "rounded-full border px-2.5 py-0.5 text-caption transition-colors disabled:opacity-50 " +
                    (ligado ? "border-brand-500 bg-brand-100/40 text-foreground" : "border-line text-ink-2 hover:text-foreground")
                  }
                >
                  {ligado ? "" : <Plus className="mr-0.5 inline h-3 w-3" aria-hidden />}
                  {c.nome}
                </button>
              );
            })}
          </div>
          <ListaDeCnaes escolhidos={cnaesLidos} onAlternar={alternarCnae} desativado={desativado} />
          <div className="flex items-start gap-2 pt-1">
            <button
              type="button"
              role="switch"
              aria-checked={f.cnaeSecundario}
              onClick={() => set("cnaeSecundario", !f.cnaeSecundario)}
              disabled={desativado}
              className={
                "relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 " +
                (f.cnaeSecundario ? "border-brand-500 bg-brand-500" : "border-line-strong bg-muted")
              }
              aria-label="Considerar CNAE secundário"
            >
              <span className={"inline-block h-3 w-3 rounded-full bg-background shadow transition-transform " + (f.cnaeSecundario ? "translate-x-3.5" : "translate-x-0.5")} />
            </button>
            <span className="text-body">
              Considerar CNAE secundário
              <span className="block text-caption text-muted-foreground">
                Desligado, só entra a empresa que tem o CNAE escolhido como principal. Ligado, vale também o CNAE secundário.
              </span>
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="f-uf">Estado</Label>
          <select
            id="f-uf"
            className={selectClasse}
            value={f.uf}
            onChange={(e) => setF((s) => ({ ...s, uf: e.target.value, cidades: [] }))}
            disabled={desativado}
          >
            <option value="">Todos</option>
            {UFS_BR.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-cidade">Cidades</Label>
          <SeletorDeCidades opcoes={cidades} escolhidas={f.cidades} onChange={(c) => set("cidades", c)} temEstado={Boolean(f.uf)} desativado={desativado} />
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-small font-semibold">Porte</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {PORTES_BUSCA.map((p) => (
              <label key={p.valor} className="flex items-center gap-2 text-body">
                <Checkbox checked={f.portes.includes(p.valor)} onCheckedChange={() => alternarPorte(p.valor)} disabled={desativado} />
                {p.rotulo}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="f-cap-min">Capital social, de</Label>
            <Input id="f-cap-min" inputMode="decimal" value={f.capitalMin} onChange={(e) => set("capitalMin", e.target.value)} placeholder="R$ 100.000" disabled={desativado} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-cap-max">até</Label>
            <Input id="f-cap-max" inputMode="decimal" value={f.capitalMax} onChange={(e) => set("capitalMax", e.target.value)} placeholder="R$ 5.000.000" disabled={desativado} />
          </div>
        </div>
        <p className="text-caption text-muted-foreground md:col-span-2">
          Faturamento não é dado público. A Receita publica o porte e o capital social, e é por eles que o CRM Agro filtra.
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="f-ab-de">Aberta desde</Label>
          <Input id="f-ab-de" type="date" value={f.abertaDesde} onChange={(e) => set("abertaDesde", e.target.value)} disabled={desativado} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="f-ab-ate">Aberta até</Label>
          <Input id="f-ab-ate" type="date" value={f.abertaAte} onChange={(e) => set("abertaAte", e.target.value)} disabled={desativado} />
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-body">
          <Checkbox checked={f.soAtivas} onCheckedChange={(v) => set("soAtivas", v === true)} disabled={desativado} />
          Só empresas ativas
        </label>
        <label className="flex items-center gap-2 text-body">
          <Checkbox checked={f.soComTelefone} onCheckedChange={(v) => set("soComTelefone", v === true)} disabled={desativado} />
          Só com telefone
        </label>
        <label className="flex items-center gap-2 text-body sm:col-span-2">
          <Checkbox checked={f.excluirPessoa} onCheckedChange={(v) => set("excluirPessoa", v === true)} disabled={desativado} />
          <span>
            Sem empresário individual e MEI
            <span className="block text-caption text-muted-foreground">São pessoas físicas com CNPJ. Por padrão ficam de fora.</span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-body sm:col-span-2">
          <Checkbox checked={f.incluirJaCadastradas} onCheckedChange={(v) => set("incluirJaCadastradas", v === true)} disabled={desativado} />
          <span>
            Incluir empresas já cadastradas
            <span className="block text-caption text-muted-foreground">
              Desligado, as que já são do CRM Agro ficam fora e não contam na quantidade pedida. Ligado, aparecem com o selo.
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-body sm:col-span-2">
          <Checkbox checked={buscaEmail} onCheckedChange={(v) => set("completarContato", v === true)} disabled={desativado || exigeEmail} />
          <span>
            Buscar e-mail e sócios de cada empresa
            <span className="block text-caption text-muted-foreground">
              {exigeEmail
                ? "Ligado porque você escolheu um filtro de e-mail. A fonte da busca não traz e-mail, então o CRM Agro consulta cada empresa."
                : "A busca não traz e-mail. Marcando, a busca fica mais lenta."}
            </span>
          </span>
        </label>
        <label className="flex items-center gap-2 text-body sm:col-span-2">
          <Checkbox checked={f.checarWhatsApp} onCheckedChange={(v) => set("checarWhatsApp", v === true)} disabled={desativado} />
          <span>
            Checar quem tem WhatsApp
            <span className="block text-caption text-muted-foreground">Gasta a cota diária do número conectado, a mesma das campanhas.</span>
          </span>
        </label>
        <details className="sm:col-span-2">
          <summary className="cursor-pointer select-none text-caption text-muted-foreground">Opções de e-mail</summary>
          <div className="mt-2 space-y-2.5">
            <label className="flex items-center gap-2 text-body">
              <Checkbox checked={f.ignorarEmailContabilidade} onCheckedChange={(v) => set("ignorarEmailContabilidade", v === true)} disabled={desativado} />
              <span className="flex items-center gap-1.5">
                Ignorar e-mails de contabilidade
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label="Como funciona" className="text-ink-3 hover:text-foreground">
                      <Info className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    O CRM Agro não lista empresas com e-mail de contabilidade: &quot;contab&quot; ou &quot;cont&quot; no e-mail, antes ou depois do @.
                  </TooltipContent>
                </Tooltip>
              </span>
            </label>
            <label className="flex items-center gap-2 text-body">
              <Checkbox checked={f.soComEmail || dominioValendo} onCheckedChange={(v) => set("soComEmail", v === true)} disabled={desativado || dominioValendo} />
              <span>
                Só com e-mail
                <span className="block text-caption text-muted-foreground">
                  {dominioValendo ? "Ligado porque você escolheu uma palavra para o e-mail." : "Descarta empresas sem e-mail válido. O CRM Agro consulta cada empresa para achar o e-mail."}
                </span>
              </span>
            </label>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-body">
                <Checkbox checked={f.emailDominioAtivo} onCheckedChange={(v) => set("emailDominioAtivo", v === true)} disabled={desativado} />
                E-mail com a palavra depois do @
              </label>
              {f.emailDominioAtivo && (
                <div className="pl-6">
                  <Input
                    value={f.emailDominio}
                    onChange={(e) => set("emailDominio", e.target.value)}
                    placeholder="grupo, agro (uma ou mais, separadas por vírgula)"
                    aria-label="Palavra no domínio do e-mail"
                    aria-invalid={!dominioValendo}
                    disabled={desativado}
                  />
                  <p className={"mt-1 text-caption " + (dominioValendo ? "text-muted-foreground" : "text-warning-700")}>
                    {dominioValendo
                      ? "Só entram empresas com a palavra no domínio, como contato@grupoabc.com.br. A parte antes do @ não conta."
                      : "Digite a palavra para filtrar."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </details>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-40 space-y-1.5">
          <Label htmlFor="f-limite">Quantas empresas</Label>
          <Input id="f-limite" inputMode="numeric" value={f.limite} onChange={(e) => set("limite", e.target.value.replace(/\D/g, "").slice(0, 3))} disabled={desativado} />
          <p className="text-caption text-muted-foreground">De 1 a 500, de empresas novas. A busca continua sozinha até juntar essa quantidade.</p>
        </div>
        <div className="flex items-center gap-3">
          {botao.andamento && (
            <span className="num text-caption text-muted-foreground" role="status" aria-live="polite">
              {botao.andamento}
            </span>
          )}
          <BuscarMais botao={botao} atual={atual} limite={limiteDaBusca(f.limite)} setIniciando={setIniciando} recarregar={recarregar} />
          {desativado && atual?.emAndamento && (
            <Button type="button" variant="outline" onClick={parar}>
              <Square className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Parar
            </Button>
          )}
          <Button type="button" onClick={buscar} disabled={desativado} aria-busy={desativado}>
            {desativado ? <GiroDeBusca /> : <Search className="mr-1.5 h-4 w-4" />}
            {botao.rotulo}
          </Button>
        </div>
      </div>
      <p className="text-caption text-muted-foreground">
        Fonte: dados abertos da Receita Federal (Minha Receita). Nada vira contato sem o seu OK na fila abaixo.
      </p>
    </div>
  );
}
