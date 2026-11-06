"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Check, ChevronRight, Loader2, X } from "lucide-react";
import type { CreatedInvite, IntegranteDTO, InviteDTO } from "@crmagro/core";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionHeader } from "@/components/ui/page-header";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { copiarTexto } from "@/lib/copiar";
import { createInviteAction, listInvitesAction, revokeInviteAction } from "./actions";
import { Integrantes, PAPEL_LABEL, PERMISSOES } from "./Integrantes";
import { SeletorTelas } from "./SeletorTelas";
import { SeletorVerTudo, resumoVerTudo, type AcessoPorTela } from "./SeletorVerTudo";

/** Papéis convidáveis (owner não é convidável — ver invites.ts). Default: member. */
const PAPEIS: { value: string; label: string; hint: string }[] = [
  { value: "admin", label: "Administrador", hint: "Vê tudo do time, configura e cuida da equipe no que o master liberar" },
  { value: "member", label: "Membro", hint: "Dia a dia: contatos, conversas, funis, fluxos, agenda" },
  { value: "viewer", label: "Só leitura", hint: "Vê as telas operacionais, sem editar" },
];

const DataCurta = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
function quando(d: Date | string | null): string {
  if (!d) return "—";
  return DataCurta.format(new Date(d));
}

/** Estado exibível de um convite (a partir das datas). */
/**
 * Por que o e-mail do convite não saiu. "Sem e-mail conectado" só quando é
 * mesmo isso (legado, sem remetente da plataforma): com a plataforma ligada,
 * mandar o admin conectar uma caixa não resolveria nada.
 */
function textoSemEmail(motivo: CreatedInvite["emailMotivo"]): string {
  switch (motivo) {
    case "sem-caixa":
      return "Sem e-mail conectado: copie o link e envie por onde quiser.";
    case "limite":
      return "Limite de e-mails de convite atingido por agora: copie o link e envie por onde quiser.";
    default:
      return "O e-mail não saiu. Copie o link e envie por onde quiser.";
  }
}

function statusDe(inv: InviteDTO): { label: string; tone: StatusTone } {
  if (inv.acceptedAt) return { label: "Aceito", tone: "ok" };
  if (inv.revokedAt) return { label: "Revogado", tone: "done" };
  if (new Date(inv.expiresAt).getTime() < Date.now()) return { label: "Expirado", tone: "done" };
  return { label: "Pendente", tone: "attention" };
}

export function EquipeTab({
  initialInvites,
  integrantes,
  euId,
  euRole,
  minhasPermissoes,
}: {
  initialInvites: InviteDTO[];
  integrantes: IntegranteDTO[];
  euId: string;
  euRole: string;
  minhasPermissoes: string[];
}) {
  const [invites, setInvites] = useState<InviteDTO[]>(initialInvites);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  // "Ver tudo" por tela do convidado: telas em que verá os registros de todos.
  const [acesso, setAcesso] = useState<AcessoPorTela>({ ver: [], editar: [] });
  // Convite de administrador: o que ele poderá fazer com a equipe (só o master escolhe).
  const [permissoes, setPermissoes] = useState<string[]>(["convidar"]);
  // Telas do convidado (F2b): vazio = todas.
  const [telas, setTelas] = useState<string[]>([]);
  const souMaster = euRole === "owner";
  const podeConvidar = souMaster || minhasPermissoes.includes("convidar");
  // Administrador convida só membro e só leitura; convidar administrador é do master.
  const papeis = PAPEIS.filter((p) => p.value !== "admin" || souMaster);
  const [enviando, setEnviando] = useState(false);
  const [novoLink, setNovoLink] = useState<string | null>(null);
  const [emailEnviado, setEmailEnviado] = useState(false);
  const [emailMotivo, setEmailMotivo] = useState<CreatedInvite["emailMotivo"]>(undefined);
  const [copiado, setCopiado] = useState(false);

  async function recarregar() {
    setInvites(await listInvitesAction());
  }

  async function convidar() {
    const e = email.trim();
    if (!e || enviando) return;
    setEnviando(true);
    setNovoLink(null);
    try {
      const res = await createInviteAction(e, role, {
        verTudoEm: role !== "admin" ? acesso.ver : [],
        editarTudoEm: role !== "admin" ? acesso.editar : [],
        permissoesEquipe: role === "admin" ? permissoes : [],
        modulos: role === "admin" ? [] : telas,
      });
      if (res.ok && res.invite) {
        setNovoLink(res.invite.link);
        setEmailEnviado(res.invite.emailSent);
        setEmailMotivo(res.invite.emailMotivo);
        setEmail("");
        await recarregar();
        toast.success(res.invite.emailSent ? "Convite enviado por e-mail" : "Convite criado. Copie o link.");
      } else {
        toast.error("Falha ao convidar", { description: res.error });
      }
    } finally {
      setEnviando(false);
    }
  }

  async function copiar(txt: string) {
    // `copiarTexto` tenta a API moderna e cai no plano B (página sem HTTPS, navegador
    // antigo); devolve false, sem lançar, se nenhum dos dois funcionar.
    const ok = await copiarTexto(txt);
    if (!ok) {
      toast.error("Não consegui copiar. Selecione e copie manualmente.");
      return;
    }
    setCopiado(true);
    toast.success("Link copiado");
    setTimeout(() => setCopiado(false), 2000);
  }

  async function revogar(id: string, e: string) {
    if (!window.confirm(`Revogar o convite de "${e}"? O link deixa de funcionar.`)) return;
    const res = await revokeInviteAction(id);
    if (res.ok) {
      toast.success("Convite revogado");
      await recarregar();
    } else {
      toast.error("Falha ao revogar", { description: res.error });
    }
  }

  // Aceito já é integrante (o core nem devolve mais); aqui fica o pendente e,
  // recolhido, o histórico (revogado/expirado). O contador conta só a lista de cima.
  const pendentes = invites.filter((i) => statusDe(i).label === "Pendente");
  const historico = invites.filter((i) => !i.acceptedAt && statusDe(i).label !== "Pendente");

  return (
    <div className="flex flex-col gap-10">
      {integrantes.length > 0 && <Integrantes inicial={integrantes} euId={euId} euRole={euRole} minhasPermissoes={minhasPermissoes} />}

      {!podeConvidar ? (
        <p className="text-small text-ink-2">Convidar pessoas depende de liberação do master.</p>
      ) : (
      <section aria-labelledby="t-convidar">
        <SectionHeader id="t-convidar" title="Convidar pessoa" />
        <p className="pt-4 text-small text-ink-2">
          A pessoa recebe um link para criar a conta e definir a senha. O convite expira em 7 dias.
        </p>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter") {
                ev.preventDefault();
                convidar();
              }
            }}
            placeholder="pessoa@empresa.com.br"
            className="sm:max-w-xs"
          />
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger className="h-9 sm:w-52" aria-label="Papel do convidado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {papeis.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={convidar} disabled={enviando || !email.trim()} className="h-9">
            {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Convidar
          </Button>
        </div>
        <p className="mt-2 text-caption text-ink-3">{PAPEIS.find((p) => p.value === role)?.hint}</p>
        {role === "admin" ? (
          <div className="mt-3 flex flex-wrap items-center gap-4 text-small text-ink-2">
            <span>Pode, com a equipe:</span>
            {PERMISSOES.map((p) => (
              <label key={p.value} className="inline-flex items-center gap-1.5">
                <Checkbox
                  checked={permissoes.includes(p.value)}
                  onCheckedChange={(v) => setPermissoes((xs) => (v ? [...xs, p.value] : xs.filter((x) => x !== p.value)))}
                />
                {p.label}
              </label>
            ))}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <details>
              <summary className="cursor-pointer text-small text-ink-2">Vê: {resumoVerTudo(acesso)}</summary>
              <div className="max-w-md pt-3">
                <SeletorVerTudo valor={acesso} onChange={setAcesso} />
              </div>
            </details>
            <details>
              <summary className="cursor-pointer text-small text-ink-2">Telas: {telas.length === 0 ? "todas" : `${telas.length} liberadas`}</summary>
              <div className="pt-3">
                <SeletorTelas valor={telas} onChange={setTelas} />
              </div>
            </details>
          </div>
        )}

        {novoLink && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="flex items-center gap-2 text-small text-ink-2">
              <StatusDot tone={emailEnviado ? "ok" : "attention"} />
              {emailEnviado ? "E-mail enviado. Se preferir, copie o link e mande você mesmo." : textoSemEmail(emailMotivo)}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="num flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-line bg-muted px-2.5 py-1.5 text-caption">{novoLink}</code>
              <Button variant="outline" size="icon-sm" onClick={() => copiar(novoLink)} aria-label="Copiar link do convite">
                {copiado ? <Check className="h-4 w-4 text-success-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        )}
      </section>
      )}

      <section aria-labelledby="t-convites">
        <SectionHeader
          id="t-convites"
          title="Convites"
          aside={<span className="num">{pendentes.length} {pendentes.length === 1 ? "pendente" : "pendentes"}</span>}
        />
        {pendentes.length === 0 ? (
          <p className="py-6 text-small text-ink-2">Nenhum convite pendente.</p>
        ) : (
          pendentes.map((inv) => <LinhaConvite key={inv.id} inv={inv} onCancelar={() => revogar(inv.id, inv.email)} />)
        )}
        {historico.length > 0 && (
          <details className="group pt-4">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-small text-ink-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden />
              Ver histórico <span className="num text-ink-3">{historico.length}</span>
            </summary>
            <div className="pt-2">
              {historico.map((inv) => (
                <LinhaConvite key={inv.id} inv={inv} />
              ))}
            </div>
          </details>
        )}
      </section>
    </div>
  );
}

/** Uma linha de convite: e-mail, papel e datas, situação e (se pendente) "Cancelar". */
function LinhaConvite({ inv, onCancelar }: { inv: InviteDTO; onCancelar?: () => void }) {
  const st = statusDe(inv);
  return (
    <div className="flex items-center gap-4 border-b border-line py-3.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-body">{inv.email}</div>
        <div className="num text-caption text-ink-3">
          {PAPEL_LABEL[inv.role] ?? inv.role} · criado {quando(inv.createdAt)} · expira {quando(inv.expiresAt)}
        </div>
      </div>
      <StatusDot tone={st.tone}>{st.label}</StatusDot>
      {onCancelar ? (
        <Button variant="ghost" size="sm" className="text-ink-2" onClick={onCancelar}>
          <X className="h-4 w-4" />
          Cancelar
        </Button>
      ) : (
        <span className="w-[92px]" aria-hidden />
      )}
    </div>
  );
}
