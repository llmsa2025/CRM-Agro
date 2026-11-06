"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Pencil, Trash2, Plus, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addCompanyAction, conferirSituacaoDasEmpresasAction, updateCompanyAction, unlinkCompanyAction } from "../actions";
import { dataCurta } from "@/lib/enriquecer-empresa";
import { CidadeEstadoCampos } from "@/components/cidade-estado";
import { EnriquecerEmpresaDialog } from "./EnriquecerEmpresaDialog";
import type { CompanyItem } from "./ContactDetail";

type Form = {
  nome: string; papel: string; cnpj: string; ie: string; naturezaJuridica: string;
  site: string; email: string; telefone: string; endereco: string; cidade: string; estado: string;
  instagram: string; linkedin: string;
};
const empty: Form = {
  nome: "", papel: "socio", cnpj: "", ie: "", naturezaJuridica: "", site: "", email: "",
  telefone: "", endereco: "", cidade: "", estado: "", instagram: "", linkedin: "",
};
function fromItem(c: CompanyItem): Form {
  return {
    nome: c.nome, papel: c.papel, cnpj: c.cnpj ?? "", ie: c.ie ?? "", naturezaJuridica: c.naturezaJuridica ?? "",
    site: c.site ?? "", email: c.email ?? "", telefone: c.telefone ?? "", endereco: c.endereco ?? "",
    cidade: c.cidade ?? "", estado: c.estado ?? "", instagram: c.instagram ?? "", linkedin: c.linkedin ?? "",
  };
}

export function CompaniesManager({ contactId, companies }: { contactId: string; companies: CompanyItem[] }) {
  const [editing, setEditing] = useState<CompanyItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [enriquecendo, setEnriquecendo] = useState<CompanyItem | null>(null);
  // Dá para enriquecer a empresa que tem CNPJ ou site (as fontes são essas duas).
  const enriquecaveis = companies.filter((c) => c.cnpj || c.site);
  const router = useRouter();
  const [ocupado, executar] = useTransition();
  const temCnpj = companies.some((c) => c.cnpj);
  const semSituacao = companies.filter((c) => c.cnpj && !c.situacao).length;

  function conferirSituacao() {
    executar(async () => {
      const r = await conferirSituacaoDasEmpresasAction(contactId);
      if (r.error || !r.resultado) return void toast.error("Não deu para conferir", { description: r.error });
      const { conferidas, inativas, semResposta } = r.resultado;
      toast.success(
        conferidas ? `${conferidas} ${conferidas === 1 ? "empresa conferida" : "empresas conferidas"}, ${inativas} ${inativas === 1 ? "inativa" : "inativas"}` : "Nenhuma empresa conferida",
        semResposta ? { description: `${semResposta} sem resposta da Receita agora.` } : undefined,
      );
      router.refresh();
    });
  }

  function desvincular(co: CompanyItem) {
    executar(async () => {
      const r = await unlinkCompanyAction(contactId, co.id);
      if (!r.ok) return void toast.error("Não deu para desvincular", { description: r.error });
      toast.success("Empresa desvinculada");
      router.refresh();
    });
  }

  return (
    <>
      <Separator className="my-4" />
      <div className="mb-2 flex items-center justify-between">
        <p className="text-caption font-medium text-muted-foreground">
          {companies.length <= 1 ? "Empresa" : "Empresas"}
        </p>
        <div className="flex items-center gap-1">
          {temCnpj && (
            <Button variant="ghost" size="sm" onClick={conferirSituacao} disabled={ocupado} title="Consulta na Receita se cada empresa está ativa ou inativa">
              <RefreshCw className={"mr-1 h-3.5 w-3.5" + (ocupado ? " animate-spin" : "")} />
              {semSituacao ? "Conferir situação" : "Atualizar situação"}
            </Button>
          )}
          {enriquecaveis.length === 1 && (
            <Button variant="ghost" size="sm" onClick={() => setEnriquecendo(enriquecaveis[0]!)}>
              <Sparkles className="mr-1 h-3.5 w-3.5" /> Enriquecer empresa
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Adicionar
          </Button>
        </div>
      </div>

      {companies.length === 0 ? (
        <p className="text-caption text-muted-foreground">Nenhuma empresa vinculada.</p>
      ) : (
        <div className="space-y-3">
          {companies.map((co) => (
            <div key={co.id} className="rounded-md border p-3">
              <div className="mb-1 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate text-body font-medium">{co.nome}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {enriquecaveis.length > 1 && (co.cnpj || co.site) && (
                    <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setEnriquecendo(co)}>
                      <Sparkles className="mr-1 h-3.5 w-3.5" /> Enriquecer
                    </Button>
                  )}
                  {co.situacao && (
                    <Badge variant={co.situacao.ativa ? "success" : "destructive"} title={`Situação na Receita: ${co.situacao.descricao ?? (co.situacao.ativa ? "Ativa" : "Inativa")}${co.situacao.consultadoEm ? `, consultada em ${dataCurta(co.situacao.consultadoEm)}` : ""}`}>
                      {co.situacao.ativa ? "Ativa" : "Inativa"}
                    </Badge>
                  )}
                  <Badge variant="outline-muted" className="capitalize">{co.papel}</Badge>
                  {co.situacao && !co.situacao.ativa && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-danger-700" onClick={() => desvincular(co)} disabled={ocupado} aria-label={`Desvincular ${co.nome}, empresa inativa`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(co)} aria-label="Editar empresa">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <dl className="space-y-1 text-body">
                {co.cnpj && <Row label="CNPJ" value={co.cnpj} />}
                {co.ie && <Row label="IE" value={co.ie} origem={co.proveniencia?.ie} />}
                {co.naturezaJuridica && <Row label="Natureza" value={co.naturezaJuridica} origem={co.proveniencia?.naturezaJuridica} />}
                {co.telefone && <Row label="Telefone" value={co.telefone} origem={co.proveniencia?.telefone} />}
                {co.email && <Row label="E-mail" value={co.email} origem={co.proveniencia?.email} />}
                {co.site && <Row label="Site" value={co.site} />}
                {co.endereco && <Row label="Endereço" value={co.endereco} origem={co.proveniencia?.endereco} />}
                {(co.cidade || co.estado) && (
                  <Row label="Cidade/UF" value={[co.cidade, co.estado].filter(Boolean).join(" / ")} />
                )}
                {co.instagram && <Row label="Instagram" value={co.instagram} origem={co.proveniencia?.instagram} />}
                {co.linkedin && <Row label="LinkedIn" value={co.linkedin} origem={co.proveniencia?.linkedin} />}
              </dl>
              {co.dadosPublicos && co.dadosPublicos.length > 0 && (
                <details className="mt-2 text-caption text-muted-foreground">
                  <summary className="cursor-pointer select-none">Dados públicos da Receita</summary>
                  <dl className="mt-1 space-y-0.5">
                    {co.dadosPublicos.map((d) => (
                      <div key={d.rotulo} className="grid grid-cols-[auto_1fr] gap-x-3">
                        <dt>{d.rotulo}</dt>
                        <dd className="min-w-0 text-right text-foreground [overflow-wrap:anywhere]">{d.valor}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="num mt-1">{co.dadosPublicos[0]!.fonteRotulo}, {dataCurta(co.dadosPublicos[0]!.consultadoEm)}</p>
                  {co.socios && co.socios.length > 0 && (
                    <ul className="mt-1">
                      {co.socios.map((sc, i) => (
                        <li key={`${sc.nome}-${i}`}>{sc.nome}{sc.qualificacao ? `, ${sc.qualificacao}` : ""}{sc.cpfExibicao ? ` · CPF ${sc.cpfExibicao}` : ""}</li>
                      ))}
                    </ul>
                  )}
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {enriquecendo && <EnriquecerEmpresaDialog contactId={contactId} companyId={enriquecendo.id} companyNome={enriquecendo.nome} onClose={() => setEnriquecendo(null)} />}
      {adding && <CompanyDialog contactId={contactId} onClose={() => setAdding(false)} />}
      {editing && <CompanyDialog contactId={contactId} company={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function Row({ label, value, origem }: { label: string; value: string; origem?: { fonteRotulo: string; consultadoEm: string } }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-3">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">
        {value}
        {origem && (
          <span className="num block text-caption text-muted-foreground">
            {origem.fonteRotulo}, {dataCurta(origem.consultadoEm)}
          </span>
        )}
      </dd>
    </div>
  );
}

function CompanyDialog({
  contactId, company, onClose,
}: { contactId: string; company?: CompanyItem; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [f, setF] = useState<Form>(company ? fromItem(company) : empty);
  const set = (k: keyof Form) => (v: string) => setF((s) => ({ ...s, [k]: v }));
  const orNull = (v: string) => (v.trim() ? v.trim() : null);

  function salvar() {
    if (!f.nome.trim()) { toast.error("Nome da empresa obrigatório"); return; }
    const payload = {
      nome: f.nome.trim(), cnpj: orNull(f.cnpj), ie: orNull(f.ie), site: orNull(f.site),
      email: orNull(f.email), telefone: orNull(f.telefone), endereco: orNull(f.endereco),
      cidade: orNull(f.cidade), estado: orNull(f.estado), instagram: orNull(f.instagram),
      linkedin: orNull(f.linkedin), naturezaJuridica: orNull(f.naturezaJuridica),
    };
    start(async () => {
      const res = company
        ? await updateCompanyAction(contactId, company.id, payload)
        : await addCompanyAction(contactId, payload, f.papel as "dono" | "socio" | "funcionario" | "outro");
      if (res.ok) { toast.success(company ? "Empresa atualizada" : "Empresa vinculada"); onClose(); router.refresh(); }
      else toast.error("Falha ao salvar", { description: res.error });
    });
  }

  function remover() {
    if (!company) return;
    start(async () => {
      const res = await unlinkCompanyAction(contactId, company.id);
      if (res.ok) { toast.success("Empresa desvinculada"); onClose(); router.refresh(); }
      else toast.error("Falha", { description: res.error });
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{company ? "Editar empresa" : "Adicionar empresa"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <F label="Nome *" value={f.nome} onChange={set("nome")} />
          {!company && (
            <div className="grid gap-1.5">
              <Label className="text-caption">Papel do contato</Label>
              <Select value={f.papel} onValueChange={set("papel")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="dono">Dono</SelectItem>
                  <SelectItem value="socio">Sócio</SelectItem>
                  <SelectItem value="funcionario">Funcionário</SelectItem>
                  <SelectItem value="outro">Outro</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <F label="CNPJ" value={f.cnpj} onChange={set("cnpj")} />
          <F label="Inscrição Estadual" value={f.ie} onChange={set("ie")} />
          <F label="Natureza jurídica" value={f.naturezaJuridica} onChange={set("naturezaJuridica")} />
          <F label="Site" value={f.site} onChange={set("site")} />
          <F label="E-mail" value={f.email} onChange={set("email")} />
          <F label="Telefone" value={f.telefone} onChange={set("telefone")} />
          <F label="Endereço" value={f.endereco} onChange={set("endereco")} />
          <CidadeEstadoCampos idPrefix="emp-local" rotuloEstado="UF" cidade={f.cidade} estado={f.estado} onChange={(v) => setF((s) => ({ ...s, ...v }))} />
          <F label="Instagram" value={f.instagram} onChange={set("instagram")} />
          <F label="LinkedIn" value={f.linkedin} onChange={set("linkedin")} />
        </div>
        <DialogFooter className="sm:justify-between">
          {company ? (
            <Button variant="ghost" onClick={remover} disabled={pending} className="text-danger-700">
              <Trash2 className="mr-1.5 h-4 w-4" /> Desvincular
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={pending}>Cancelar</Button>
            <Button onClick={salvar} disabled={pending || !f.nome.trim()}>Salvar</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function F({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-caption">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
