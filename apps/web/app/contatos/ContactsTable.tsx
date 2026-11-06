"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, Loader2, Pencil, Sprout, Tag as TagIcon, Trash2, UserCheck, UserRoundCheck, Workflow, X } from "lucide-react";
import { Label } from "@/components/ui/label";
import { CidadeEstadoForm } from "@/components/cidade-estado";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge, RELACIONAMENTO_STATUS } from "@/components/ui/status-badge";
import { InteresseBadge } from "@/components/ui/interesse-badge";
import { TagPill } from "@/components/ui/tag-pill";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Interesse } from "@prisma/client";
import { daysSince, formatPhone } from "@/lib/format";
import {
  assignTagBulkAction,
  createTagAction,
  deleteContactsBulkAction,
  rodarFluxoNosSelecionadosAction,
  verificarAgroDoFiltroAction,
  setContactTagAction,
  setStatusBulkAction,
  tagEmMassaAction,
  toggleContactTagAction,
  transferirContatosAction,
  updateContactAction,
  type ContactFilter,
} from "./actions";
import type { PessoaLite } from "@/components/escopo/filtro-vendedor";
import { AgroPills, FotoNaFila, fraseDoLote, verificarVarios, type EstadoDaFotoAgro } from "./agro";

export type ContactRow = {
  id: string;
  nome: string;
  sobrenome: string | null;
  telefone: string | null;
  email: string | null;
  empresa: string | null;
  status: string;
  interesse: string;
  origem: string | null;
  createdAt: string;
  tags: { id: string; nome: string; cor: string | null }[]; // todas as tags do contato, na ordem em que foram postas
  whatsapp: string | null; // E.164 para o link wa.me
  instagram: string | null; // @handle, se houver identifier
  linkedin: string | null; // handle/url, se houver identifier
  cidade: string | null;
  estado: string | null;
  cargo: string | null;
  /** Responsável pelo contato (regra do dono, 28/09). */
  responsavel: string | null;
  /** O que o contato é no agro (verificador): produtor, fazenda, armazem, algodoeira, pecuaria, transportadora. */
  agroTipos: string[];
  /** Estado da foto do WhatsApp na verificação (null = nunca verificado). */
  agroFoto: EstadoDaFotoAgro | null;
  /** Onde a busca por texto achou este contato ("nome", "CNPJ da empresa", "histórico (conversa)" com trecho). Vazio sem busca. */
  achados?: { rotulo: string; trecho?: { antes: string; achado: string; depois: string } }[];
};

/** Nome + sobrenome para a lista (no cadastro continuam em campos separados). */
function nomeCompleto(c: { nome: string; sobrenome: string | null }): string {
  return [c.nome, c.sobrenome].map((p) => p?.trim()).filter(Boolean).join(" ");
}

type TagLite = { id: string; nome: string; cor: string | null };
type FluxoLite = { id: string; nome: string };

export function ContactsTable({
  rows,
  total,
  totalTruncado = false,
  filter,
  tags,
  exportQuery,
  transferirPara = [],
  mostrarResponsavel = false,
  fluxosParaRodar = [],
  podeRodarFluxo = false,
}: {
  rows: ContactRow[];
  total: number;
  /** A busca achou mais do que o teto: o total é parcial e "selecionar todos do filtro" some. */
  totalTruncado?: boolean;
  filter: ContactFilter;
  tags: TagLite[];
  exportQuery: string;
  /** Pessoas ativas para "Transferir para…" (vazio = sem permissão, botão some). */
  transferirPara?: PessoaLite[];
  /** Coluna "Responsável": para quem vê o time todo (o vendedor só vê os dele). */
  mostrarResponsavel?: boolean;
  /** Fluxos no ar com o gatilho "Contatos selecionados", para o menu "Rodar fluxo". */
  fluxosParaRodar?: FluxoLite[];
  /** Tem a tela Fluxos e pode alterar: sem isso o botão "Rodar fluxo" some. */
  podeRodarFluxo?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // "todos os N do filtro" (não só a página) — o modo Gmail.
  const [allInFilter, setAllInFilter] = useState(false);
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTagNome, setNewTagNome] = useState("");
  const [editing, setEditing] = useState<ContactRow | null>(null);

  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectedCount = allInFilter ? total : selected.size;
  const hasSelection = selectedCount > 0;

  function toggleRow(id: string, checked: boolean) {
    setAllInFilter(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllPage(checked: boolean) {
    setAllInFilter(false);
    setSelected(checked ? new Set(pageIds) : new Set());
  }

  function clearSelection() {
    setSelected(new Set());
    setAllInFilter(false);
  }

  /** Alvo das ações em massa: ids explícitos ou todos do filtro. */
  function target(): { ids?: string[]; filter?: ContactFilter } {
    return allInFilter ? { filter } : { ids: [...selected] };
  }

  function run(
    fn: () => Promise<{ ok?: boolean; error?: string }>,
    okMsg: (n: number) => string,
    n: number,
  ) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) {
        toast.success(okMsg(n));
        clearSelection();
        router.refresh();
      } else {
        toast.error("Falha", { description: res.error });
      }
    });
  }

  /** Põe ou tira UMA tag dos selecionados; as outras tags deles ficam. */
  function tagEmMassa(t: TagLite, acao: "adicionar" | "tirar") {
    startTransition(async () => {
      const res = await tagEmMassaAction({ ...target(), tagId: t.id, acao });
      if (res.ok) {
        const n = res.updated ?? 0;
        if (acao === "tirar") toast.success(n ? `Tag "${t.nome}" tirada de ${n} contato(s)` : `Nenhum dos selecionados tinha "${t.nome}"`);
        else toast.success(`Tag "${t.nome}" adicionada a ${n} contato(s)`, res.jaTinham ? { description: `${res.jaTinham} já tinha(m)` } : undefined);
        clearSelection();
        router.refresh();
      } else {
        toast.error("Não mudei as tags", { description: res.error });
      }
    });
  }

  function removerTodasAsTags() {
    if (!confirm(`Tirar todas as tags de ${selectedCount} contato(s)?`)) return;
    run(() => assignTagBulkAction({ ...target(), tagId: null }), (n) => `Tags removidas de ${n} contato(s)`, selectedCount);
  }

  /** Marca o status de todos os selecionados (ex.: Cliente para quem já é cliente na base). */
  function marcarStatus(status: "novo" | "ja_conversou" | "cliente") {
    const rotulo = RELACIONAMENTO_STATUS[status]?.label ?? status;
    startTransition(async () => {
      const res = await setStatusBulkAction({ ...target(), status });
      if (res.ok) {
        const partes = [`${res.atualizados ?? 0} marcado(s) como ${rotulo}`];
        if (res.jaEstavam) partes.push(`${res.jaEstavam} já estava(m)`);
        if (res.pulados) partes.push(`${res.pulados} pediu(ram) para sair e não mudou(aram)`);
        toast.success(partes.join(", "));
        clearSelection();
        router.refresh();
      } else {
        toast.error("Não mudei o status", { description: res.error });
      }
    });
  }

  function transferir(p: PessoaLite) {
    if (!confirm(`Mudar o responsável de ${selectedCount} contato(s) para ${p.nome}? Os negócios e o histórico vão junto.`)) return;
    startTransition(async () => {
      const res = await transferirContatosAction({ ...target(), para: p.id });
      if (res.ok) {
        const negocios = res.negocios ? ` e ${res.negocios} negócio(s)` : "";
        toast.success(`${p.nome} agora é responsável por ${res.contatos ?? 0} contato(s)${negocios}`);
        clearSelection();
        router.refresh();
      } else {
        toast.error("Não deu para mudar o responsável", { description: res.error });
      }
    });
  }

  /** "Rodar fluxo": inscreve os selecionados (ou todos do filtro) num fluxo de gatilho "Contatos selecionados". */
  function rodarFluxo(f: FluxoLite) {
    if (!confirm(`Rodar o fluxo "${f.nome}" em ${selectedCount} contato(s)?`)) return;
    startTransition(async () => {
      const res = await rodarFluxoNosSelecionadosAction({ ...target(), flowId: f.id });
      if (!res.ok) {
        toast.error("Não consegui rodar o fluxo", { description: res.error });
        return;
      }
      const entraram = res.inscritas ?? 0;
      const ignorados = res.ignorados ?? 0;
      if (entraram === 0) {
        toast.error("Ninguém entrou no fluxo", { description: "Os selecionados já estão nele ou pediram para sair." });
      } else {
        toast.success(`${entraram} contato(s) entraram no fluxo`, {
          description: ignorados ? `${ignorados} já estavam nele ou pediram para sair.` : undefined,
        });
      }
      clearSelection();
      router.refresh();
    });
  }

  /** "Selecionar todos do filtro": a base inteira do filtro vai para o worker, e o andamento aparece no topo da lista. */
  function verificarAgroDoFiltro() {
    if (!confirm(`Verificar o agro dos ${total} contatos do filtro? Roda em segundo plano e leva um tempo, você pode sair da tela.`)) return;
    startTransition(async () => {
      const res = await verificarAgroDoFiltroAction({ filter });
      if (res.ok) {
        toast.success("Verificação do agro começou", { description: `${res.total} contatos. O andamento aparece no topo da lista.` });
        clearSelection();
        router.refresh();
      } else {
        toast.error("Não deu para começar", { description: res.error });
      }
    });
  }

  /** Verifica o agro de TODOS os selecionados da página, com o andamento num aviso só. */
  function verificarAgro() {
    if (allInFilter) return verificarAgroDoFiltro();
    const ids = [...selected];
    if (!ids.length) return;
    startTransition(async () => {
      const aviso = toast.loading(`Verificando 0 de ${ids.length}`);
      const resumo = await verificarVarios(ids, (feitos, tot) => toast.loading(`Verificando ${feitos} de ${tot}`, { id: aviso }));
      const { titulo, descricao } = fraseDoLote(resumo);
      toast.success(titulo, { id: aviso, description: descricao });
      clearSelection();
      router.refresh();
    });
  }

  function excluir() {
    if (!confirm(`Excluir ${selectedCount} contato(s)? Esta ação não pode ser desfeita.`)) return;
    run(() => deleteContactsBulkAction(target()), (n) => `${n} contato(s) excluído(s)`, selectedCount);
  }

  function criarTagEMover() {
    const nome = newTagNome.trim();
    if (!nome) return;
    startTransition(async () => {
      const created = await createTagAction({ nome });
      if (!created.ok || !created.tagId) {
        toast.error("Falha ao criar tag", { description: created.error });
        return;
      }
      const res = await tagEmMassaAction({ ...target(), tagId: created.tagId, acao: "adicionar" });
      if (res.ok) {
        toast.success(`Tag "${nome}" ${created.criada === false ? "adicionada" : "criada e adicionada"} a ${res.updated ?? selectedCount} contato(s)`);
        setNewTagOpen(false);
        setNewTagNome("");
        clearSelection();
        router.refresh();
      } else {
        toast.error(created.criada === false ? "Falhou ao aplicar a tag" : "Tag criada, mas falhou ao aplicar", { description: res.error });
      }
    });
  }

  function exportarSelecionados() {
    const q = allInFilter ? exportQuery : `ids=${[...selected].join(",")}`;
    window.open(`/api/contatos/export?format=csv&${q}`, "_blank");
  }

  return (
    <div className="space-y-3">
      {/* Barra de ação em massa — aparece no lugar do cabeçalho de ações. */}
      {hasSelection && (
        <div className="flex flex-wrap items-center gap-2 border-y border-line px-3 py-2">
          <span className="num text-body font-medium">
            {selectedCount} {selectedCount === 1 ? "selecionado" : "selecionados"}
            {!allInFilter && total > selectedCount && <span className="font-normal text-ink-2"> de {totalTruncado ? "mais de " : ""}{total} no filtro</span>}
          </span>

          {allPageSelected && !allInFilter && !totalTruncado && total > pageIds.length && (
            <Button variant="ghost-subtle" size="sm" onClick={() => setAllInFilter(true)}>
              Selecionar todos os {total} do filtro
            </Button>
          )}
          {allInFilter && (
            <Button variant="ghost-subtle" size="sm" onClick={clearSelection}>
              Limpar seleção
            </Button>
          )}

          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={pending}>
                  <UserCheck className="mr-1.5 h-4 w-4" />
                  Marcar status
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Novo status</DropdownMenuLabel>
                {(["novo", "ja_conversou", "cliente"] as const).map((s) => (
                  <DropdownMenuItem key={s} onSelect={() => marcarStatus(s)}>
                    {RELACIONAMENTO_STATUS[s]?.label ?? s}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={pending}>
                  <TagIcon className="mr-1.5 h-4 w-4" />
                  Tags
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {/* Adicionar e tirar mexem só na tag escolhida; as outras tags de cada contato ficam. */}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Adicionar tag</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                    {tags.length === 0 && <DropdownMenuItem disabled>Nenhuma tag ainda</DropdownMenuItem>}
                    {tags.map((t) => (
                      <DropdownMenuItem key={t.id} onSelect={() => tagEmMassa(t, "adicionar")}>
                        <TagPill nome={t.nome} cor={t.cor} />
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setNewTagOpen(true)}>+ Nova tag…</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={tags.length === 0}>Tirar tag</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                    {tags.map((t) => (
                      <DropdownMenuItem key={t.id} onSelect={() => tagEmMassa(t, "tirar")}>
                        <TagPill nome={t.nome} cor={t.cor} />
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={removerTodasAsTags}>Tirar todas as tags</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {transferirPara.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={pending}>
                    <UserRoundCheck className="mr-1.5 h-4 w-4" />
                    Mudar responsável
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Novo responsável</DropdownMenuLabel>
                  {transferirPara.map((p) => (
                    <DropdownMenuItem key={p.id} onSelect={() => transferir(p)}>
                      {p.nome}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {podeRodarFluxo && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" disabled={pending}>
                    <Workflow className="mr-1.5 h-4 w-4" />
                    Rodar fluxo
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>Fluxo para rodar</DropdownMenuLabel>
                  {fluxosParaRodar.length === 0 ? (
                    <DropdownMenuItem disabled>Nenhum fluxo no ar com gatilho Contatos selecionados</DropdownMenuItem>
                  ) : (
                    fluxosParaRodar.map((f) => (
                      <DropdownMenuItem key={f.id} onSelect={() => rodarFluxo(f)}>
                        {f.nome}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={verificarAgro}
              disabled={pending}
              title={allInFilter ? `Verifica os ${total} contatos do filtro em segundo plano` : `Verifica os ${selectedCount} selecionados`}
            >
              <Sprout className="mr-1.5 h-4 w-4" />
              Verificar agro
            </Button>

            <Button variant="outline" size="sm" onClick={exportarSelecionados} disabled={pending}>
              <Download className="mr-1.5 h-4 w-4" />
              Exportar
            </Button>

            <Button variant="outline" size="sm" onClick={excluir} disabled={pending}>
              {pending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-4 w-4" />
              )}
              Excluir
            </Button>

            <Button variant="ghost-subtle" size="icon-sm" onClick={clearSelection} aria-label="Limpar">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={allInFilter || allPageSelected}
                  onCheckedChange={(c) => toggleAllPage(Boolean(c))}
                  aria-label="Selecionar todos"
                />
              </TableHead>
              <TableHead>Nome</TableHead>
              <TableHead>WhatsApp</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>Empresa</TableHead>
              <TableHead title="Selecione os contatos e use Verificar agro para classificar">Agro</TableHead>
              <TableHead>Cidade</TableHead>
              <TableHead>Relacionamento</TableHead>
              <TableHead>Interesse</TableHead>
              <TableHead>Tag</TableHead>
              {mostrarResponsavel && <TableHead>Responsável</TableHead>}
              <TableHead>Criado</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => {
              const checked = allInFilter || selected.has(c.id);
              return (
                <TableRow key={c.id} data-state={checked ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => toggleRow(c.id, Boolean(v))}
                      aria-label={`Selecionar ${nomeCompleto(c)}`}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Link href={`/contatos/${c.id}`} className="font-medium text-foreground hover:underline">
                      {nomeCompleto(c) || <span className="font-normal text-ink-3">Sem nome</span>}
                    </Link>
                    {c.achados && c.achados.length > 0 && (
                      <div className="mt-0.5 text-xs font-normal text-ink-3">
                        <p>Achado em: {c.achados.map((a) => a.rotulo).join(", ")}</p>
                        {c.achados
                          .filter((a) => a.trecho)
                          .map((a) => (
                            <p key={a.rotulo} className="mt-0.5 max-w-[420px] whitespace-normal">
                              {a.trecho!.antes}
                              {a.trecho!.achado && <mark className="rounded-sm bg-brand-100 px-0.5 text-foreground">{a.trecho!.achado}</mark>}
                              {a.trecho!.depois}
                            </p>
                          ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="num whitespace-nowrap">
                    <WhatsAppCell row={c} />
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate text-ink-2">{c.email ?? "—"}</TableCell>
                  <TableCell className="max-w-[220px] truncate text-ink-2">{c.empresa ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      {c.agroTipos.length > 0 ? <AgroPills tipos={c.agroTipos} /> : <span className="text-ink-3">—</span>}
                      {c.agroFoto === "na_fila" && <FotoNaFila />}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-ink-2">{c.cidade ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>
                    {c.interesse === "nao_avaliado" ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <InteresseBadge interesse={c.interesse as Interesse} />
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <RowTagCell row={c} tags={tags} onDone={() => router.refresh()} />
                  </TableCell>
                  {mostrarResponsavel && <TableCell className="whitespace-nowrap text-ink-2">{c.responsavel ?? "—"}</TableCell>}
                  <TableCell className="num whitespace-nowrap text-ink-2">{daysSince(c.createdAt)}</TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="h-7 w-7 text-ink-3"
                      onClick={() => setEditing(c)}
                      aria-label={`Editar ${nomeCompleto(c)}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Dialog: criar nova tag e aplicar aos selecionados */}
      <Dialog open={newTagOpen} onOpenChange={setNewTagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova tag</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Nome da tag (ex.: Sem WhatsApp)"
            value={newTagNome}
            onChange={(e) => setNewTagNome(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && criarTagEMover()}
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setNewTagOpen(false)}>
              Cancelar
            </Button>
            <Button size="sm" onClick={criarTagEMover} disabled={pending || !newTagNome.trim()}>
              Criar e aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edição rápida do contato (sem sair da listagem) */}
      <EditContactDialog row={editing} onClose={() => setEditing(null)} onDone={() => router.refresh()} />
    </div>
  );
}

/** Célula de tags: clica → marca, desmarca ou cria tag ali mesmo, sem mexer nas outras. */
function RowTagCell({
  row,
  tags,
  onDone,
}: {
  row: ContactRow;
  tags: TagLite[];
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  // A célula cabe em duas pílulas; o resto vira "+N" (o title do botão lista todas).
  const mostradas = row.tags.slice(0, 2);
  const resto = row.tags.length - mostradas.length;
  const varias = row.tags.length > 1;

  /** Marca ou desmarca UMA tag; as outras do contato ficam. */
  function alternar(tagId: string, tem: boolean) {
    startTransition(async () => {
      const res = await toggleContactTagAction({ contactId: row.id, tagId, acao: tem ? "tirar" : "adicionar" });
      if (res.ok) onDone();
      else toast.error("Falha", { description: res.error });
    });
  }

  function apply(tagId: string | null) {
    startTransition(async () => {
      const res = await setContactTagAction({ contactId: row.id, tagId });
      if (res.ok) onDone();
      else toast.error("Falha", { description: res.error });
    });
  }

  function novaTag() {
    const nome = window.prompt("Nome da nova tag:")?.trim();
    if (!nome) return;
    startTransition(async () => {
      const created = await createTagAction({ nome });
      if (!created.ok || !created.tagId) {
        toast.error("Falha ao criar tag", { description: created.error });
        return;
      }
      const res = await toggleContactTagAction({ contactId: row.id, tagId: created.tagId, acao: "adicionar" });
      if (res.ok) onDone();
      else toast.error("Falha ao aplicar", { description: res.error });
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="inline-flex items-center gap-1 rounded hover:opacity-80"
          disabled={pending}
          aria-label="Alterar tag"
          title={row.tags.length > 0 ? row.tags.map((t) => t.nome).join(", ") : undefined}
        >
          {mostradas.length > 0 ? (
            <>
              {mostradas.map((t) => (
                <TagPill key={t.id} nome={t.nome} cor={t.cor} className={varias ? "max-w-[110px]" : undefined} />
              ))}
              {resto > 0 && <span className="num text-caption text-ink-3">+{resto}</span>}
            </>
          ) : (
            <span className="text-ink-3">—</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {/* Marcar põe a tag e desmarcar tira; as outras tags do contato ficam. */}
        <DropdownMenuLabel>Tags do contato</DropdownMenuLabel>
        {tags.length === 0 && <DropdownMenuItem disabled>Nenhuma tag ainda</DropdownMenuItem>}
        <div className="max-h-72 overflow-y-auto">
          {tags.map((t) => {
            const tem = row.tags.some((x) => x.id === t.id);
            return (
              <DropdownMenuCheckboxItem key={t.id} checked={tem} disabled={pending} onCheckedChange={() => alternar(t.id, tem)}>
                <TagPill nome={t.nome} cor={t.cor} />
              </DropdownMenuCheckboxItem>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={novaTag}>+ Nova tag…</DropdownMenuItem>
        {row.tags.length > 0 ? (
          <DropdownMenuItem onSelect={() => apply(null)}>{varias ? "Tirar todas as tags" : "Tirar a tag"}</DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Diálogo de edição rápida do contato — sem sair da listagem. */
function EditContactDialog({
  row,
  onClose,
  onDone,
}: {
  row: ContactRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    if (!row) return;
    formData.set("id", row.id);
    startTransition(async () => {
      const res = await updateContactAction(undefined, formData);
      if (res.ok) {
        toast.success("Contato atualizado");
        onClose();
        onDone();
      } else {
        toast.error("Falha ao salvar", { description: res.error });
      }
    });
  }

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar contato</DialogTitle>
        </DialogHeader>
        {row && (
          <form action={submit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-nome">Nome</Label>
                <Input id="edit-nome" name="nome" defaultValue={row.nome} required />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-sobrenome">Sobrenome</Label>
                <Input id="edit-sobrenome" name="sobrenome" defaultValue={row.sobrenome ?? ""} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-tel">Telefone</Label>
                <Input id="edit-tel" name="telefone" defaultValue={row.telefone ?? ""} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-email">E-mail</Label>
                <Input id="edit-email" name="email" type="email" defaultValue={row.email ?? ""} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-empresa">Empresa</Label>
                <Input id="edit-empresa" name="empresa" defaultValue={row.empresa ?? ""} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cargo">Cargo</Label>
                <Input id="edit-cargo" name="cargo" defaultValue={row.cargo ?? ""} />
              </div>
            </div>
            <CidadeEstadoForm idPrefix="edit-local" cidadeInicial={row.cidade} estadoInicial={row.estado} />
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                Salvar
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Número do WhatsApp; clique abre a conversa DENTRO da plataforma. */
function WhatsAppCell({ row }: { row: ContactRow }) {
  const numero = row.whatsapp?.replace(/\D/g, "");
  if (!numero) return <span className="text-ink-3">{formatPhone(row.telefone)}</span>;
  return (
    <Link
      href={`/conversas?contact=${row.id}&canal=whatsapp`}
      title="Abrir conversa no WhatsApp (dentro da plataforma)"
      className="text-foreground hover:underline"
    >
      {formatPhone(row.telefone)}
    </Link>
  );
}
