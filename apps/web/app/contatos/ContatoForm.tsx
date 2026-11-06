"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { responsaveisAction } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CidadeEstadoCampos } from "@/components/cidade-estado";
import { TagsInput } from "@/components/tags-input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Formulário de cadastro de contato (pessoa + empresa). É UM só: a tela "Novo contato" usa na página e o
 * "Cadastrar contato" do WhatsApp usa dentro de um pop-up que rola até o fim. Os campos, as regras e o que vai
 * para o servidor são os mesmos nos dois lugares.
 */

type PForm = {
  nome: string; sobrenome: string; telefone: string; email: string; cpf: string; cargo: string;
  endereco: string; cidade: string; estado: string; instagram: string; linkedin: string; tags: string[];
  areaHa: string; faturamentoAnual: string;
};
type CForm = {
  nome: string; cnpj: string; ie: string; site: string; email: string; telefone: string;
  endereco: string; cidade: string; estado: string; instagram: string; linkedin: string; naturezaJuridica: string;
};

const emptyPerson: PForm = {
  nome: "", sobrenome: "", telefone: "", email: "", cpf: "", cargo: "",
  endereco: "", cidade: "", estado: "", instagram: "", linkedin: "", tags: [],
  areaHa: "", faturamentoAnual: "",
};
const emptyCompany: CForm = {
  nome: "", cnpj: "", ie: "", site: "", email: "", telefone: "",
  endereco: "", cidade: "", estado: "", instagram: "", linkedin: "", naturezaJuridica: "",
};

export type StatusDoCadastro = "novo" | "ja_conversou" | "cliente";
export const OPCOES_DE_STATUS: ReadonlyArray<{ value: StatusDoCadastro; label: string }> = [
  { value: "novo", label: "Nunca contatado" },
  { value: "ja_conversou", label: "Contatado" },
  { value: "cliente", label: "Cliente" },
];

/** O que o formulário entrega ao salvar (mesma forma da action `createContactFullAction`). */
export type DadosDoCadastro = {
  person: {
    nome: string; sobrenome: string | null; telefone: string | null; email: string | null; cpf: string | null;
    cargo: string | null; endereco: string | null; cidade: string | null; estado: string | null;
    instagram: string | null; linkedin: string | null; tags: string[]; areaHa: string | null; faturamentoAnual: string | null;
  };
  company: {
    nome: string; cnpj: string | null; ie: string | null; site: string | null; email: string | null; telefone: string | null;
    endereco: string | null; cidade: string | null; estado: string | null; instagram: string | null;
    linkedin: string | null; naturezaJuridica: string | null;
  } | null;
  papel: "dono" | "socio" | "funcionario" | "outro";
  responsavelId: string;
  relacionamentoStatus: StatusDoCadastro;
};

function Field({
  label, value, onChange, type = "text", placeholder, inputMode, id,
}: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
  inputMode?: "decimal" | "text"; id?: string;
}) {
  // Todo rótulo aponta para o seu campo (leitor de tela, clique no rótulo e teste de tela dependem disso).
  const gerado = useId();
  const campo = id ?? gerado;
  return (
    <div className="grid gap-1.5">
      <Label className="text-caption" htmlFor={campo}>{label}</Label>
      <Input id={campo} value={value} onChange={(e) => onChange(e.target.value)} type={type} placeholder={placeholder} inputMode={inputMode} />
    </div>
  );
}

/** Bloco do formulário: cartão na página, seção com título dentro do pop-up. */
function Bloco({ titulo, janela, children }: { titulo: string; janela: boolean; children: ReactNode }) {
  if (janela) {
    return (
      <section className="space-y-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
        <h3 className="text-label text-foreground">{titulo}</h3>
        <div className="grid gap-3 sm:grid-cols-2">{children}</div>
      </section>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-h3">{titulo}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

export function ContatoForm({
  variante,
  inicial,
  statusInicial,
  telefoneObrigatorio = false,
  salvando,
  rotuloSalvar,
  contatoExistenteId,
  onSalvar,
  onCancelar,
}: {
  variante: "pagina" | "janela";
  /** Nome, sobrenome e telefone que já se sabe (o pop-up do canal traz o da agenda e o número da conversa). */
  inicial?: Partial<Pick<PForm, "nome" | "sobrenome" | "telefone">>;
  statusInicial: StatusDoCadastro;
  /** Conversa sem número (WhatsApp mostrou só um código): o telefone passa a ser obrigatório. */
  telefoneObrigatorio?: boolean;
  salvando: boolean;
  rotuloSalvar: string;
  /** Contato que já existe (o servidor recusou o cadastro por duplicado): mostra o link para abri-lo. */
  contatoExistenteId?: string | null;
  onSalvar: (dados: DadosDoCadastro) => void;
  onCancelar?: () => void;
}) {
  const janela = variante === "janela";
  const [p, setP] = useState<PForm>({ ...emptyPerson, ...inicial });
  const [c, setC] = useState<CForm>(emptyCompany);
  const [papel, setPapel] = useState<DadosDoCadastro["papel"]>("socio");
  const [status, setStatus] = useState<StatusDoCadastro>(statusInicial);
  const [mesmoEndereco, setMesmoEndereco] = useState(false);
  // Responsável (obrigatório, regra do dono de 28/09): o gestor escolhe; o vendedor é ele.
  const [resp, setResp] = useState<{ pessoas: { id: string; nome: string }[]; eu: string | null; podeEscolher: boolean } | null>(null);
  const [responsavelId, setResponsavelId] = useState<string>("");
  useEffect(() => {
    responsaveisAction()
      .then((r) => {
        setResp(r);
        setResponsavelId(r.eu ?? "");
      })
      .catch(() => setResp(null));
  }, []);

  const sp = (k: keyof PForm) => (v: string) => setP((s) => ({ ...s, [k]: v }));
  const sc = (k: keyof CForm) => (v: string) => setC((s) => ({ ...s, [k]: v }));
  const orNull = (v: string) => (v.trim() ? v.trim() : null);
  const idDe = (nome: string) => (janela ? `cad-${nome}` : undefined);
  const idTags = useId();

  function salvar() {
    if (!p.nome.trim()) {
      toast.error("Informe o nome da pessoa");
      return;
    }
    if (telefoneObrigatorio && !p.telefone.trim()) {
      toast.error("Informe o telefone", { description: "O WhatsApp mostrou só um código para esta conversa, então o número precisa vir de você." });
      return;
    }
    if (!responsavelId) {
      toast.error("Escolha o responsável pelo contato");
      return;
    }
    // Empresa entra só se tiver nome. Marcado "mesmo endereço": copia o da pessoa.
    const temEmpresa = !!c.nome.trim();
    onSalvar({
      person: {
        nome: p.nome.trim(),
        sobrenome: orNull(p.sobrenome),
        telefone: orNull(p.telefone),
        email: orNull(p.email),
        cpf: orNull(p.cpf),
        cargo: orNull(p.cargo),
        endereco: orNull(p.endereco),
        cidade: orNull(p.cidade),
        estado: orNull(p.estado),
        instagram: orNull(p.instagram),
        linkedin: orNull(p.linkedin),
        tags: p.tags,
        // Opcionais; o servidor entende "1.250" e "2,5".
        areaHa: orNull(p.areaHa),
        faturamentoAnual: orNull(p.faturamentoAnual),
      },
      company: temEmpresa
        ? {
            nome: c.nome.trim(),
            cnpj: orNull(c.cnpj),
            ie: orNull(c.ie),
            site: orNull(c.site),
            email: orNull(c.email),
            telefone: orNull(c.telefone),
            endereco: mesmoEndereco ? orNull(p.endereco) : orNull(c.endereco),
            cidade: mesmoEndereco ? orNull(p.cidade) : orNull(c.cidade),
            estado: mesmoEndereco ? orNull(p.estado) : orNull(c.estado),
            instagram: orNull(c.instagram),
            linkedin: orNull(c.linkedin),
            naturezaJuridica: orNull(c.naturezaJuridica),
          }
        : null,
      papel,
      responsavelId,
      relacionamentoStatus: status,
    });
  }

  return (
    <div className={janela ? "space-y-4" : "flex max-w-2xl flex-col gap-6"}>
      <Bloco titulo="Contato (pessoa)" janela={janela}>
        <Field id={idDe("nome")} label="Nome *" value={p.nome} onChange={sp("nome")} />
        <Field id={idDe("sobrenome")} label="Sobrenome" value={p.sobrenome} onChange={sp("sobrenome")} />
        <Field id={idDe("telefone")} label={telefoneObrigatorio ? "Telefone *" : "Telefone"} value={p.telefone} onChange={sp("telefone")} placeholder="+55 66 9 9999-9999" />
        <Field label="E-mail" value={p.email} onChange={sp("email")} type="email" />
        <Field label="Profissão" value={p.cargo} onChange={sp("cargo")} placeholder="Produtor Rural" />
        <Field label="CPF" value={p.cpf} onChange={sp("cpf")} />
        <Field label="Endereço" value={p.endereco} onChange={sp("endereco")} />
        <CidadeEstadoCampos idPrefix={idDe("local")} cidade={p.cidade} estado={p.estado} onChange={(v) => setP((s) => ({ ...s, ...v }))} />
        <Field label="Instagram" value={p.instagram} onChange={sp("instagram")} />
        <Field label="LinkedIn" value={p.linkedin} onChange={sp("linkedin")} />
        <Field label="Área (ha)" value={p.areaHa} onChange={sp("areaHa")} placeholder="1.250" inputMode="decimal" />
        <Field label="Faturamento anual (R$)" value={p.faturamentoAnual} onChange={sp("faturamentoAnual")} placeholder="2.400.000" inputMode="decimal" />
        <div className="grid gap-1.5 sm:col-span-2">
          <Label className="text-caption" htmlFor={idTags}>Tags</Label>
          <TagsInput id={idTags} value={p.tags} onChange={(tags) => setP((s) => ({ ...s, tags }))} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-caption">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as StatusDoCadastro)}>
            <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {OPCOES_DE_STATUS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption text-ink-3">Já é cliente? Marque Cliente. O interesse (se quer comprar) é outra coisa e fica na ficha.</p>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-caption">Responsável *</Label>
          <Select value={responsavelId} onValueChange={setResponsavelId} disabled={!resp?.podeEscolher}>
            <SelectTrigger aria-label="Responsável">
              <SelectValue placeholder={resp ? "Escolha o responsável" : "Carregando…"} />
            </SelectTrigger>
            <SelectContent>
              {(resp?.pessoas ?? []).map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-caption text-ink-3">
            {resp?.podeEscolher
              ? "Quem cuida deste contato. Só ele (e a gestão) vê o contato e o histórico."
              : "Você fica como responsável. Para passar a outra pessoa, peça à gestão."}
          </p>
        </div>
        {contatoExistenteId && (
          <p className="text-small sm:col-span-2">
            <Link href={`/contatos/${contatoExistenteId}`} className="font-medium text-brand-500 hover:underline">
              Abrir o contato que já existe →
            </Link>
          </p>
        )}
      </Bloco>

      <Bloco titulo="Empresa (opcional)" janela={janela}>
        <Field label="Nome da empresa" value={c.nome} onChange={sc("nome")} />
        <div className="grid gap-1.5">
          <Label className="text-caption">Papel do contato</Label>
          <Select value={papel} onValueChange={(v) => setPapel(v as DadosDoCadastro["papel"])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="dono">Dono</SelectItem>
              <SelectItem value="socio">Sócio</SelectItem>
              <SelectItem value="funcionario">Funcionário</SelectItem>
              <SelectItem value="outro">Outro</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Field label="CNPJ" value={c.cnpj} onChange={sc("cnpj")} />
        <Field label="Inscrição Estadual" value={c.ie} onChange={sc("ie")} />
        <Field label="Natureza jurídica" value={c.naturezaJuridica} onChange={sc("naturezaJuridica")} placeholder="Empresário Individual" />
        <Field label="Site" value={c.site} onChange={sc("site")} />
        <Field label="E-mail da empresa" value={c.email} onChange={sc("email")} type="email" />
        <Field label="Telefone da empresa" value={c.telefone} onChange={sc("telefone")} />
        <Field label="Instagram" value={c.instagram} onChange={sc("instagram")} />
        <Field label="LinkedIn" value={c.linkedin} onChange={sc("linkedin")} />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox checked={mesmoEndereco} onCheckedChange={(v) => setMesmoEndereco(v === true)} />
          Usar o mesmo endereço da pessoa na empresa
        </label>
        {!mesmoEndereco && (
          <>
            <Field label="Endereço da empresa" value={c.endereco} onChange={sc("endereco")} />
            <CidadeEstadoCampos idPrefix={idDe("empresa-local")} cidade={c.cidade} estado={c.estado} onChange={(v) => setC((s) => ({ ...s, ...v }))} />
          </>
        )}
      </Bloco>

      <div
        className={
          janela
            ? "sticky -bottom-6 -mx-6 -mb-6 flex justify-end gap-2 border-t border-line bg-background px-6 py-4"
            : "flex justify-end"
        }
      >
        {onCancelar && (
          <Button variant="outline" onClick={onCancelar} disabled={salvando}>
            Cancelar
          </Button>
        )}
        <Button onClick={salvar} disabled={salvando || !p.nome.trim()}>
          {salvando ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          {salvando ? "Salvando…" : rotuloSalvar}
        </Button>
      </div>
    </div>
  );
}
