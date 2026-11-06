"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BookOpen, Loader2, MoreVertical, Pencil, Plus, Star, Trash2 } from "lucide-react";
import type { MetodologiaDTO, ModeloDeMetodologia } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDate } from "@/lib/format";
import {
  atualizarMetodologiaAction,
  criarMetodologiaAction,
  definirPadraoAction,
  excluirMetodologiaAction,
  type RespostaMetodologia,
} from "./metodologias-actions";

type Finalidade = MetodologiaDTO["finalidade"];

/** Finalidades que a tela oferece (rótulo e frase de ajuda vêm do servidor: o cliente não importa valor do core). */
export type FinalidadeDaTela = { id: Finalidade; nome: string; descricao: string };

type Janela = null | { tipo: "nova" } | { tipo: "editar"; m: MetodologiaDTO } | { tipo: "excluir"; m: MetodologiaDTO };

/**
 * Aba "Metodologias" (Integrações → IA): como o agente conduz a abordagem (SPIN Selling, BANT, a do próprio
 * time). Cada uma tem uma finalidade, que decide onde ela aparece e onde vale, e há uma padrão por finalidade.
 * Quem não é administrador só vê a lista.
 */
export function Metodologias({
  lista,
  finalidades,
  modelos,
  podeEditar,
}: {
  lista: MetodologiaDTO[];
  finalidades: FinalidadeDaTela[];
  modelos: ModeloDeMetodologia[];
  podeEditar: boolean;
}) {
  const router = useRouter();
  const [janela, setJanela] = useState<Janela>(null);
  const [ocupado, setOcupado] = useState(false);
  const nomeDaFinalidade = (f: string) => finalidades.find((x) => x.id === f)?.nome ?? f;

  async function rodar(acao: () => Promise<RespostaMetodologia>, ok: string, aoTerminar?: () => void): Promise<void> {
    setOcupado(true);
    const r = await acao();
    setOcupado(false);
    if (r.ok) {
      toast.success(ok);
      aoTerminar?.();
      router.refresh();
    } else toast.error("Não deu certo", { description: r.error });
  }

  const nova = (
    <Button onClick={() => setJanela({ tipo: "nova" })}>
      <Plus /> Nova metodologia
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="num text-small text-ink-2">
          {lista.length} {lista.length === 1 ? "metodologia" : "metodologias"} · {lista.filter((m) => m.padrao).length} {lista.filter((m) => m.padrao).length === 1 ? "padrão" : "padrões"}
        </p>
        {podeEditar && lista.length > 0 && nova}
      </div>

      {lista.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="Nenhuma metodologia ainda"
          description={
            podeEditar
              ? "Uma metodologia diz como o agente conduz a abordagem, como o SPIN Selling. Crie a sua e escolha para que ela serve."
              : "Peça a um administrador para criar as metodologias da equipe."
          }
          action={podeEditar ? nova : undefined}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Metodologia</TableHead>
              <TableHead>Serve para</TableHead>
              <TableHead>Atualizada</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Ações</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lista.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="font-medium">{m.nome}</div>
                  {m.descricao && <div className="text-caption text-ink-3">{m.descricao}</div>}
                </TableCell>
                <TableCell className="text-ink-2">{nomeDaFinalidade(m.finalidade)}</TableCell>
                <TableCell className="num text-ink-2">{formatDate(m.updatedAt)}</TableCell>
                <TableCell>{m.padrao ? <StatusDot tone="ok">Padrão</StatusDot> : <StatusDot tone="empty">Disponível</StatusDot>}</TableCell>
                <TableCell>
                  {podeEditar && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Ações da metodologia ${m.nome}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setJanela({ tipo: "editar", m })}>
                          <Pencil className="mr-2 h-4 w-4" /> Editar
                        </DropdownMenuItem>
                        {!m.padrao && (
                          <DropdownMenuItem onSelect={() => void rodar(() => definirPadraoAction(m.id), `${m.nome} é a padrão de ${nomeDaFinalidade(m.finalidade)}`)}>
                            <Star className="mr-2 h-4 w-4" /> Definir como padrão
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setJanela({ tipo: "excluir", m })} className="text-danger-500 focus:text-danger-500">
                          <Trash2 className="mr-2 h-4 w-4" /> Excluir
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <JanelaDeNova
        aberta={janela?.tipo === "nova"}
        ocupado={ocupado}
        finalidades={finalidades}
        modelos={modelos}
        fechar={() => setJanela(null)}
        criar={(v) => rodar(() => criarMetodologiaAction(v), "Metodologia criada", () => setJanela(null))}
      />
      {janela?.tipo === "editar" && (
        <JanelaDeEdicao
          key={janela.m.id}
          m={janela.m}
          nomeDaFinalidade={nomeDaFinalidade(janela.m.finalidade)}
          ocupado={ocupado}
          fechar={() => setJanela(null)}
          salvar={(v) => rodar(() => atualizarMetodologiaAction(janela.m.id, v), "Metodologia salva", () => setJanela(null))}
        />
      )}
      <Dialog open={janela?.tipo === "excluir"} onOpenChange={(a) => !a && setJanela(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Excluir “{janela?.tipo === "excluir" ? janela.m.nome : ""}”?</DialogTitle>
            <DialogDescription>
              {janela?.tipo === "excluir" && janela.m.padrao
                ? "É a padrão desta finalidade: sem ela, os agentes que a usavam rodam sem metodologia até você escolher outra. "
                : "Os passos que a escolheram passam a usar a padrão. "}
              Não dá para desfazer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setJanela(null)} disabled={ocupado}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={ocupado}
              onClick={() => janela?.tipo === "excluir" && void rodar(() => excluirMetodologiaAction(janela.m.id), "Metodologia excluída", () => setJanela(null))}
            >
              {ocupado ? <Loader2 className="animate-spin" /> : null}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Janelas ────────────────────────────────────────────────────────────────

function JanelaDeNova({
  aberta,
  ocupado,
  finalidades,
  modelos,
  fechar,
  criar,
}: {
  aberta: boolean;
  ocupado: boolean;
  finalidades: FinalidadeDaTela[];
  modelos: ModeloDeMetodologia[];
  fechar: () => void;
  criar: (v: { nome: string; finalidade: string; descricao?: string; conteudo: string; modelo?: string }) => Promise<void>;
}) {
  const [finalidade, setFinalidade] = useState<string>("");
  const [modelo, setModelo] = useState<string>("branco");
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [conteudo, setConteudo] = useState("");
  const modelosDaFinalidade = modelos.filter((m) => m.finalidade === finalidade);
  const ajuda = finalidades.find((f) => f.id === finalidade)?.descricao;

  function escolherModelo(slug: string) {
    setModelo(slug);
    const m = modelos.find((x) => x.slug === slug);
    if (m) {
      setNome(m.nome);
      setDescricao(m.descricao);
      setConteudo(m.conteudo);
    } else {
      setNome("");
      setDescricao("");
      setConteudo("");
    }
  }

  return (
    <Dialog open={aberta} onOpenChange={(a) => !a && !ocupado && fechar()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nova metodologia</DialogTitle>
          <DialogDescription>Primeiro escolha para que ela serve: isso decide onde ela aparece e onde vale.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Serve para</Label>
            <Select
              value={finalidade}
              onValueChange={(v) => {
                setFinalidade(v);
                setModelo("branco");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Escolha a finalidade" />
              </SelectTrigger>
              <SelectContent>
                {finalidades.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ajuda && <p className="text-caption text-ink-3">{ajuda}</p>}
          </div>
          {finalidade && modelosDaFinalidade.length > 0 && (
            <div className="space-y-1">
              <Label>Começar de</Label>
              <Select value={modelo} onValueChange={escolherModelo}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="branco">Em branco</SelectItem>
                  {modelosDaFinalidade.map((m) => (
                    <SelectItem key={m.slug} value={m.slug}>
                      {m.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {finalidade && (
            <>
              <div className="space-y-1">
                <Label htmlFor="mt-nome">Nome</Label>
                <Input id="mt-nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Minha metodologia" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mt-desc">Descrição (opcional)</Label>
                <Input id="mt-desc" value={descricao} onChange={(e) => setDescricao(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="mt-conteudo">Como conduzir</Label>
                <Textarea id="mt-conteudo" value={conteudo} onChange={(e) => setConteudo(e.target.value)} rows={10} placeholder="Descreva a ordem das perguntas, o ritmo da conversa e o que evitar." />
                <p className="num text-caption text-ink-3">{conteudo.length} de 6000 caracteres</p>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button
            disabled={ocupado || !finalidade || !nome.trim() || !conteudo.trim()}
            onClick={async () => {
              await criar({ nome, finalidade, descricao: descricao || undefined, conteudo, modelo: modelo !== "branco" ? modelo : undefined });
              setFinalidade("");
              setModelo("branco");
              setNome("");
              setDescricao("");
              setConteudo("");
            }}
          >
            {ocupado ? <Loader2 className="animate-spin" /> : null}
            Criar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JanelaDeEdicao({
  m,
  nomeDaFinalidade,
  ocupado,
  fechar,
  salvar,
}: {
  m: MetodologiaDTO;
  nomeDaFinalidade: string;
  ocupado: boolean;
  fechar: () => void;
  salvar: (v: { nome: string; descricao: string | null; conteudo: string }) => Promise<void>;
}) {
  const [nome, setNome] = useState(m.nome);
  const [descricao, setDescricao] = useState(m.descricao ?? "");
  const [conteudo, setConteudo] = useState(m.conteudo);
  return (
    <Dialog open onOpenChange={(a) => !a && !ocupado && fechar()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Editar metodologia</DialogTitle>
          <DialogDescription>Serve para {nomeDaFinalidade}. A finalidade não muda depois de criada.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="mt-edit-nome">Nome</Label>
            <Input id="mt-edit-nome" value={nome} onChange={(e) => setNome(e.target.value)} autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mt-edit-desc">Descrição (opcional)</Label>
            <Input id="mt-edit-desc" value={descricao} onChange={(e) => setDescricao(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mt-edit-conteudo">Como conduzir</Label>
            <Textarea id="mt-edit-conteudo" value={conteudo} onChange={(e) => setConteudo(e.target.value)} rows={12} />
            <p className="num text-caption text-ink-3">{conteudo.length} de 6000 caracteres</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button disabled={ocupado || !nome.trim() || !conteudo.trim()} onClick={() => salvar({ nome, descricao: descricao.trim() || null, conteudo })}>
            {ocupado ? <Loader2 className="animate-spin" /> : null}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
