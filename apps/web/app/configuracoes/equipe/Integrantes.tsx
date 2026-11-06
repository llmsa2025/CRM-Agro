"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Loader2, MoreHorizontal } from "lucide-react";
import type { IntegranteDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SectionHeader } from "@/components/ui/page-header";
import { StatusDot } from "@/components/ui/status-dot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { copiarTexto } from "@/lib/copiar";
import { SeletorTelas } from "./SeletorTelas";
import { SeletorVerTudo, resumoVerTudo, type AcessoPorTela } from "./SeletorVerTudo";
import {
  alterarPapelAction,
  definirPermissoesEquipeAction,
  definirVerTudoEmAction,
  definirModulosAction,
  desativarAction,
  excluirAction,
  reativarAction,
  redefinirSenhaAction,
  type IntegranteState,
} from "./actions";

/** Rótulos dos papéis na tela (owner = master: quem criou a empresa; é um só). */
export const PAPEL_LABEL: Record<string, string> = {
  owner: "Master",
  admin: "Administrador",
  member: "Membro",
  viewer: "Só leitura",
};

/**
 * Rótulo do papel de um integrante. "owner" que NÃO é o master do time sobrou de
 * antes da regra do master único: aparece como "Dono antigo" até o master
 * mudar o papel dele (ou o script de operação rebaixar).
 */
export function rotuloDoPapel(u: Pick<IntegranteDTO, "role" | "master">): string {
  if (u.master) return "Master";
  if (u.role === "owner") return "Dono antigo";
  return PAPEL_LABEL[u.role] ?? u.role;
}
/** O que o master libera para cada administrador fazer com a equipe. */
export const PERMISSOES: { value: string; label: string }[] = [
  { value: "convidar", label: "Convidar" },
  { value: "desativar", label: "Desativar" },
  { value: "excluir", label: "Excluir" },
];

const DataCurta = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "America/Sao_Paulo" });

/**
 * Integrantes do time (plano-equipe-permissoes F2a): papel (o master troca),
 * "ver tudo" por tela, o que cada administrador faz com a equipe (o master
 * decide), desativar/reativar, excluir transferindo os registros, redefinir
 * senha (master; a senha provisória aparece uma vez). O master é um só e
 * fixo: ninguém mexe nele por aqui (troca só pelo banco). O core confere tudo de novo.
 */
export function Integrantes({
  inicial,
  euId,
  euRole,
  minhasPermissoes,
}: {
  inicial: IntegranteDTO[];
  euId: string;
  euRole: string;
  minhasPermissoes: string[];
}) {
  const [lista, setLista] = useState(inicial);
  const [pending, start] = useTransition();
  const [excluindo, setExcluindo] = useState<IntegranteDTO | null>(null);
  const [destino, setDestino] = useState("");
  const [senha, setSenha] = useState<{ nome: string; senha: string } | null>(null);
  // Telas (F2b): quem está sendo editado e a escolha em andamento.
  const [telasDe, setTelasDe] = useState<IntegranteDTO | null>(null);
  const [telas, setTelas] = useState<string[]>([]);
  // "Ver tudo" por tela: quem está sendo editado e a escolha em andamento.
  const [verDe, setVerDe] = useState<IntegranteDTO | null>(null);
  const [acesso, setAcesso] = useState<AcessoPorTela>({ ver: [], editar: [] });
  // Papel "owner" (poderes de dono: papel, permissões, senha). Depois do master
  // único, só o master tem; "owner" antigo ainda sem rebaixar também.
  const souDono = euRole === "owner";
  // O master do time (um só e fixo): o único que mexe em "owner" antigo.
  const souMaster = lista.some((u) => u.id === euId && u.master);
  const pode = (p: string) => souDono || minhasPermissoes.includes(p);

  function aplicar(r: IntegranteState, msg: string) {
    if (!r.ok) return void toast.error("Não deu certo", { description: r.error });
    setLista((l) => l.map((u) => (u.id === r.integrante.id ? r.integrante : u)));
    toast.success(msg);
  }
  const agir = (fn: () => Promise<IntegranteState>, msg: string) => start(async () => aplicar(await fn(), msg));

  /**
   * Posso mexer nesta pessoa? Nunca em mim nem no master; "owner" antigo → só
   * o master; administrador → só quem é dono (espelha `conferirHierarquia`).
   */
  const alcanca = (u: IntegranteDTO) => u.id !== euId && !u.master && (u.role !== "owner" || souMaster) && (u.role !== "admin" || souDono);

  function excluir() {
    if (!excluindo || !destino) return;
    const alvo = excluindo;
    start(async () => {
      const r = await excluirAction(alvo.id, destino);
      if (!r.ok) return void toast.error("Não deu para excluir", { description: r.error });
      setLista((l) => l.filter((u) => u.id !== alvo.id));
      const n = Object.values(r.transferidos).reduce((a, b) => a + b, 0);
      toast.success(`${alvo.nome} excluído`, { description: n ? `${n} registros transferidos.` : undefined });
      setExcluindo(null);
      setDestino("");
    });
  }

  function redefinirSenha(u: IntegranteDTO) {
    if (!confirm(`Redefinir a senha de ${u.nome}? As sessões abertas dele caem e você recebe uma senha provisória para passar a ele.`)) return;
    start(async () => {
      const r = await redefinirSenhaAction(u.id);
      if (!r.ok) return void toast.error("Não deu para redefinir", { description: r.error });
      setSenha({ nome: u.nome, senha: r.senha });
    });
  }

  const ativosParaReceber = (alvo: IntegranteDTO) => lista.filter((u) => u.id !== alvo.id && !u.desativadoEm);

  return (
    <section aria-labelledby="t-integrantes">
      <SectionHeader id="t-integrantes" title="Integrantes" aside={<span className="num">{lista.filter((u) => !u.desativadoEm).length} ativos</span>} />
      {lista.map((u) => {
        const eu = u.id === euId;
        return (
          <div key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-body">
                {u.nome} {eu && <span className="text-ink-3">(você)</span>}
              </div>
              <div className="num truncate text-caption text-ink-3">
                {u.email} · último acesso {u.ultimoAcesso ? DataCurta.format(new Date(u.ultimoAcesso)) : "—"}
              </div>
              {u.role === "admin" && (
                <div className="flex flex-wrap items-center gap-3 pt-1.5 text-caption text-ink-2">
                  <span>Pode:</span>
                  {PERMISSOES.map((p) => (
                    <label key={p.value} className="inline-flex items-center gap-1.5">
                      <Checkbox
                        checked={u.permissoesEquipe.includes(p.value as never)}
                        disabled={!souDono || !alcanca(u) || pending}
                        onCheckedChange={(v) => {
                          const atual = u.permissoesEquipe as string[];
                          const nova = v ? [...atual, p.value] : atual.filter((x) => x !== p.value);
                          agir(() => definirPermissoesEquipeAction(u.id, nova), "Permissões salvas");
                        }}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              )}
            </div>

            {(u.role === "member" || u.role === "viewer") && (
              <Button
                variant="ghost"
                size="sm"
                className="text-caption text-ink-2"
                disabled={!alcanca(u) || pending}
                onClick={() => {
                  setTelas(u.modulos);
                  setTelasDe(u);
                }}
                title="Telas que a pessoa pode abrir"
              >
                Telas: {u.modulos.length === 0 ? "todas" : u.modulos.length}
              </Button>
            )}

            {(u.role === "member" || u.role === "viewer") && (
              <Button
                variant="ghost"
                size="sm"
                className="text-caption text-ink-2"
                disabled={!alcanca(u) || pending}
                onClick={() => {
                  setAcesso({ ver: u.verTudoEm, editar: u.editarTudoEm });
                  setVerDe(u);
                }}
                title="Em cada tela: só os registros dele, ver os de todos ou ver e editar os de todos"
              >
                Vê: {resumoVerTudo({ ver: u.verTudoEm, editar: u.editarTudoEm })}
              </Button>
            )}

            {souDono && alcanca(u) ? (
              <Select value={u.role} onValueChange={(v) => agir(() => alterarPapelAction(u.id, v), "Papel alterado")} disabled={pending}>
                <SelectTrigger className="h-8 w-40 text-small" aria-label={`Papel de ${u.nome}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* "owner" antigo: aparece como está, mas não se escolhe (o master é um só). */}
                  {u.role === "owner" && (
                    <SelectItem value="owner" disabled>
                      {rotuloDoPapel(u)}
                    </SelectItem>
                  )}
                  {["admin", "member", "viewer"].map((r) => (
                    <SelectItem key={r} value={r}>
                      {PAPEL_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="w-40 text-small text-ink-2" title={u.role === "owner" && !u.master ? "Conta de antes do master único: o master muda o papel dela" : undefined}>
                {rotuloDoPapel(u)}
              </span>
            )}

            <span className="w-24">{u.desativadoEm ? <StatusDot tone="done">Desativado</StatusDot> : <StatusDot tone="ok">Ativo</StatusDot>}</span>

            {alcanca(u) && (pode("desativar") || pode("excluir") || souDono) ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Ações para ${u.nome}`} disabled={pending}>
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {pode("desativar") &&
                    (u.desativadoEm ? (
                      <DropdownMenuItem onSelect={() => agir(() => reativarAction(u.id), `${u.nome} reativado`)}>Reativar</DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        onSelect={() => {
                          if (confirm(`Desativar ${u.nome}? A pessoa perde o acesso em até 1 minuto e deixa de receber avisos; nada é apagado.`)) agir(() => desativarAction(u.id), `${u.nome} desativado`);
                        }}
                      >
                        Desativar
                      </DropdownMenuItem>
                    ))}
                  {souDono && <DropdownMenuItem onSelect={() => redefinirSenha(u)}>Redefinir senha</DropdownMenuItem>}
                  {pode("excluir") && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-danger-500 focus:text-danger-500" onSelect={() => setExcluindo(u)}>
                        Excluir…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <span className="w-8" aria-hidden />
            )}
          </div>
        );
      })}

      <Dialog open={telasDe !== null} onOpenChange={(v) => !v && setTelasDe(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Telas de {telasDe?.nome}</DialogTitle>
            <DialogDescription>O que ficar desmarcado some do menu e é bloqueado na tela e no servidor. A pessoa entra de novo para valer.</DialogDescription>
          </DialogHeader>
          <SeletorTelas valor={telas} onChange={setTelas} disabled={pending} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTelasDe(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                const alvo = telasDe;
                if (!alvo) return;
                start(async () => {
                  aplicar(await definirModulosAction(alvo.id, telas), "Telas salvas");
                  setTelasDe(null);
                });
              }}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={verDe !== null} onOpenChange={(v) => !v && setVerDe(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>O que {verDe?.nome} vê e altera</DialogTitle>
            <DialogDescription>
              Em cada tela: só os registros dele (e os compartilhados), ver os de todos sem alterar, ou ver e editar os de todos. Vale na tela e no servidor; a pessoa entra de novo para valer.
            </DialogDescription>
          </DialogHeader>
          <SeletorVerTudo valor={acesso} onChange={setAcesso} disabled={pending} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setVerDe(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                const alvo = verDe;
                if (!alvo) return;
                start(async () => {
                  aplicar(await definirVerTudoEmAction(alvo.id, acesso.ver, acesso.editar), "Acesso salvo");
                  setVerDe(null);
                });
              }}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={excluindo !== null} onOpenChange={(v) => !v && setExcluindo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir {excluindo?.nome}?</DialogTitle>
            <DialogDescription>
              A conta é apagada. Antes, os contatos, campanhas, importações, compromissos e metas dela passam para a pessoa escolhida abaixo. Para só tirar o acesso, use Desativar.
            </DialogDescription>
          </DialogHeader>
          <Select value={destino} onValueChange={setDestino}>
            <SelectTrigger aria-label="Quem recebe os registros">
              <SelectValue placeholder="Transferir os registros para…" />
            </SelectTrigger>
            <SelectContent>
              {excluindo &&
                ativosParaReceber(excluindo).map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.nome} · {rotuloDoPapel(u)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExcluindo(null)} disabled={pending}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={excluir} disabled={pending || !destino}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />}
              Transferir e excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={senha !== null} onOpenChange={(v) => !v && setSenha(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Senha provisória de {senha?.nome}</DialogTitle>
            <DialogDescription>Passe esta senha à pessoa. Ela aparece só agora; depois de fechar, não dá para ver de novo.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code className="num flex-1 rounded-md border border-line bg-muted px-3 py-2 text-body tracking-wider">{senha?.senha}</code>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Copiar senha"
              onClick={async () => {
                if (!senha) return;
                // Só o aviso vai para o toast: a senha nunca é logada nem exibida fora do campo.
                const ok = await copiarTexto(senha.senha);
                if (!ok) {
                  toast.error("Não consegui copiar. Selecione a senha e copie manualmente.");
                  return;
                }
                toast.success("Senha copiada");
              }}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setSenha(null)}>Pronto</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
