"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileText, Link2, Loader2, MoreVertical, Pencil, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import type { DocumentoDaBase, ResumoDaBase } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDate } from "@/lib/format";
import {
  adicionarArquivoAction,
  adicionarLinkAction,
  adicionarTextoAction,
  atualizarDoGoogleAction,
  atualizarDocumentoAction,
  excluirDocumentoAction,
  lerDocumentoAction,
  type RespostaBase,
} from "./conhecimento-actions";

const NOME_DA_FONTE: Record<DocumentoDaBase["fonte"], string> = {
  texto: "Texto",
  pdf: "PDF",
  word: "Word",
  excel: "Excel",
  google: "Google",
};

/** "850", "3,4 mil", "120 mil". */
function tamanho(n: number): string {
  if (n < 1000) return `${n}`;
  const mil = n / 1000;
  return `${mil < 10 ? mil.toFixed(1).replace(".", ",") : Math.round(mil)} mil`;
}

type Janela = null | { tipo: "texto" } | { tipo: "arquivo" } | { tipo: "link" } | { tipo: "editar"; doc: DocumentoDaBase } | { tipo: "excluir"; doc: DocumentoDaBase };

/**
 * Aba "Base de conhecimento" (Integrações → IA): os documentos que o Agente IA consulta para falar da empresa
 * sem inventar. Quem não é administrador só vê a lista.
 */
export function BaseDeConhecimento({ docs, resumo, podeEditar }: { docs: DocumentoDaBase[]; resumo: ResumoDaBase; podeEditar: boolean }) {
  const router = useRouter();
  const [janela, setJanela] = useState<Janela>(null);
  const [ocupado, setOcupado] = useState(false);

  /** Roda a ação, avisa o resultado e atualiza a lista. */
  async function rodar(acao: () => Promise<RespostaBase>, ok: string, aoTerminar?: () => void): Promise<void> {
    setOcupado(true);
    const r = await acao();
    setOcupado(false);
    if (r.ok) {
      toast.success(ok);
      aoTerminar?.();
      router.refresh();
    } else toast.error("Não deu certo", { description: r.error });
  }

  const adicionar = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus /> Adicionar
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => setJanela({ tipo: "arquivo" })}>
          <Upload className="mr-2 h-4 w-4" /> Enviar arquivo
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setJanela({ tipo: "texto" })}>
          <FileText className="mr-2 h-4 w-4" /> Escrever texto
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setJanela({ tipo: "link" })}>
          <Link2 className="mr-2 h-4 w-4" /> Link do Google
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="num text-small text-ink-2">
          {resumo.documentos} {resumo.documentos === 1 ? "documento" : "documentos"} · {resumo.ativos} {resumo.ativos === 1 ? "ligado" : "ligados"} · {tamanho(resumo.caracteres)} caracteres
        </p>
        {podeEditar && docs.length > 0 && adicionar}
      </div>

      {docs.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="Nenhum documento ainda"
          description="Coloque aqui o que o Agente IA precisa saber da empresa: quem vocês são, produtos, preços, condições. Ele consulta isto antes de escrever e não inventa o que não estiver aqui. Aceita PDF, Word, Excel, texto e link do Google."
          action={podeEditar ? adicionar : undefined}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Documento</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="text-right">Caracteres</TableHead>
              <TableHead>Atualizado</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Ações</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <div className="font-medium">{d.titulo}</div>
                  {d.nomeArquivo && <div className="text-caption text-ink-3">{d.nomeArquivo}</div>}
                </TableCell>
                <TableCell className="text-ink-2">{NOME_DA_FONTE[d.fonte]}</TableCell>
                <TableCell className="num text-right text-ink-2">{tamanho(d.caracteres)}</TableCell>
                <TableCell className="num text-ink-2">{formatDate(d.updatedAt)}</TableCell>
                <TableCell>{d.ativo ? <StatusDot tone="ok">Ligado</StatusDot> : <StatusDot tone="empty">Desligado</StatusDot>}</TableCell>
                <TableCell>
                  {podeEditar && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Ações do documento ${d.titulo}`}>
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setJanela({ tipo: "editar", doc: d })}>
                          <Pencil className="mr-2 h-4 w-4" /> {d.fonte === "texto" ? "Editar texto" : "Renomear"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void rodar(() => atualizarDocumentoAction(d.id, { ativo: !d.ativo }), d.ativo ? "Documento desligado" : "Documento ligado")}>
                          {d.ativo ? "Desligar" : "Ligar"}
                        </DropdownMenuItem>
                        {d.fonte === "google" && (
                          <DropdownMenuItem onSelect={() => void rodar(() => atualizarDoGoogleAction(d.id), "Documento atualizado")}>
                            <RefreshCw className="mr-2 h-4 w-4" /> Atualizar do Google
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setJanela({ tipo: "excluir", doc: d })} className="text-danger-500 focus:text-danger-500">
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

      <JanelaDeTexto aberta={janela?.tipo === "texto"} ocupado={ocupado} fechar={() => setJanela(null)} enviar={(v) => rodar(() => adicionarTextoAction(v), "Texto adicionado", () => setJanela(null))} />
      <JanelaDeArquivo aberta={janela?.tipo === "arquivo"} ocupado={ocupado} fechar={() => setJanela(null)} enviar={(fd) => rodar(() => adicionarArquivoAction(fd), "Arquivo lido e adicionado", () => setJanela(null))} />
      <JanelaDeLink aberta={janela?.tipo === "link"} ocupado={ocupado} fechar={() => setJanela(null)} enviar={(v) => rodar(() => adicionarLinkAction(v), "Documento do Google adicionado", () => setJanela(null))} />
      {janela?.tipo === "editar" && (
        <JanelaDeEdicao
          key={janela.doc.id}
          doc={janela.doc}
          ocupado={ocupado}
          fechar={() => setJanela(null)}
          salvar={(v) => rodar(() => atualizarDocumentoAction(janela.doc.id, v), "Documento salvo", () => setJanela(null))}
        />
      )}
      <Dialog open={janela?.tipo === "excluir"} onOpenChange={(a) => !a && setJanela(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Excluir “{janela?.tipo === "excluir" ? janela.doc.titulo : ""}”?</DialogTitle>
            <DialogDescription>O Agente IA deixa de consultar este documento. Não dá para desfazer. Para só parar de usar por um tempo, desligue.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setJanela(null)} disabled={ocupado}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={ocupado}
              onClick={() => janela?.tipo === "excluir" && void rodar(() => excluirDocumentoAction(janela.doc.id), "Documento excluído", () => setJanela(null))}
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

type PropsDaJanela<T> = { aberta: boolean; ocupado: boolean; fechar: () => void; enviar: (v: T) => Promise<void> };

function JanelaDeTexto({ aberta, ocupado, fechar, enviar }: PropsDaJanela<{ titulo: string; conteudo: string }>) {
  const [titulo, setTitulo] = useState("");
  const [conteudo, setConteudo] = useState("");
  return (
    <Dialog open={aberta} onOpenChange={(a) => !a && fechar()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Escrever texto</DialogTitle>
          <DialogDescription>Cole ou escreva o que o agente precisa saber. Um assunto por texto funciona melhor.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bc-titulo">Título</Label>
            <Input id="bc-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex.: Sobre a empresa" autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bc-conteudo">Texto</Label>
            <Textarea id="bc-conteudo" value={conteudo} onChange={(e) => setConteudo(e.target.value)} rows={10} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button
            disabled={ocupado || !titulo.trim() || !conteudo.trim()}
            onClick={async () => {
              await enviar({ titulo, conteudo });
              setTitulo("");
              setConteudo("");
            }}
          >
            {ocupado ? <Loader2 className="animate-spin" /> : null}
            Adicionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JanelaDeArquivo({ aberta, ocupado, fechar, enviar }: PropsDaJanela<FormData>) {
  const campo = useRef<HTMLInputElement>(null);
  const [nome, setNome] = useState("");
  const [titulo, setTitulo] = useState("");
  return (
    <Dialog open={aberta} onOpenChange={(a) => !a && !ocupado && fechar()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enviar arquivo</DialogTitle>
          <DialogDescription>PDF, Word (.docx), Excel (.xlsx), .txt, .md ou .csv, de até 15 MB. O CRM Agro lê o texto e não guarda o arquivo.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bc-arquivo">Arquivo</Label>
            <Input
              id="bc-arquivo"
              ref={campo}
              type="file"
              accept=".pdf,.docx,.xlsx,.txt,.md,.csv"
              onChange={(e) => setNome(e.target.files?.[0]?.name.replace(/\.[^.]+$/, "") ?? "")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bc-arquivo-titulo">Título (opcional)</Label>
            <Input id="bc-arquivo-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder={nome || "Usa o nome do arquivo"} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button
            disabled={ocupado || !nome}
            onClick={async () => {
              const arquivo = campo.current?.files?.[0];
              if (!arquivo) return;
              const fd = new FormData();
              fd.set("arquivo", arquivo);
              if (titulo.trim()) fd.set("titulo", titulo.trim());
              await enviar(fd);
              setNome("");
              setTitulo("");
              if (campo.current) campo.current.value = "";
            }}
          >
            {ocupado ? <Loader2 className="animate-spin" /> : null}
            {ocupado ? "Lendo o arquivo" : "Adicionar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function JanelaDeLink({ aberta, ocupado, fechar, enviar }: PropsDaJanela<{ url: string; titulo?: string }>) {
  const [url, setUrl] = useState("");
  const [titulo, setTitulo] = useState("");
  return (
    <Dialog open={aberta} onOpenChange={(a) => !a && !ocupado && fechar()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link do Google</DialogTitle>
          <DialogDescription>
            Docs, Planilhas, Apresentações ou arquivo do Drive. No Google, clique em Compartilhar e deixe “Qualquer pessoa com o link” pode ver.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bc-link">Link</Label>
            <Input id="bc-link" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/document/d/…" autoFocus />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bc-link-titulo">Título (opcional)</Label>
            <Input id="bc-link-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button
            disabled={ocupado || !url.trim()}
            onClick={async () => {
              await enviar({ url: url.trim(), titulo: titulo.trim() || undefined });
              setUrl("");
              setTitulo("");
            }}
          >
            {ocupado ? <Loader2 className="animate-spin" /> : null}
            {ocupado ? "Buscando" : "Adicionar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Renomear (qualquer documento) e, para "texto", editar o conteúdo (carregado ao abrir). */
function JanelaDeEdicao({ doc, ocupado, fechar, salvar }: { doc: DocumentoDaBase; ocupado: boolean; fechar: () => void; salvar: (v: { titulo: string; conteudo?: string }) => Promise<void> }) {
  const ehTexto = doc.fonte === "texto";
  const [titulo, setTitulo] = useState(doc.titulo);
  const [conteudo, setConteudo] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  useEffect(() => {
    if (!ehTexto) return;
    let ativo = true;
    void lerDocumentoAction(doc.id).then((r) => {
      if (!ativo) return;
      if (r.ok) setConteudo(r.conteudo ?? "");
      else setErro(r.error);
    });
    return () => {
      ativo = false;
    };
  }, [doc.id, ehTexto]);
  return (
    <Dialog open onOpenChange={(a) => !a && fechar()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{ehTexto ? "Editar texto" : "Renomear documento"}</DialogTitle>
          {!ehTexto && <DialogDescription>O conteúdo de arquivo e de link não se edita aqui. Para trocar, envie de novo ou use “Atualizar do Google”.</DialogDescription>}
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="bc-edit-titulo">Título</Label>
            <Input id="bc-edit-titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} autoFocus />
          </div>
          {ehTexto && (
            <div className="space-y-1">
              <Label htmlFor="bc-edit-conteudo">Texto</Label>
              {erro ? (
                <p className="text-small text-danger-500">{erro}</p>
              ) : conteudo === null ? (
                <p className="text-small text-ink-3">Carregando…</p>
              ) : (
                <Textarea id="bc-edit-conteudo" value={conteudo} onChange={(e) => setConteudo(e.target.value)} rows={10} />
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={fechar} disabled={ocupado}>
            Cancelar
          </Button>
          <Button
            disabled={ocupado || !titulo.trim() || (ehTexto && conteudo === null)}
            onClick={() => salvar({ titulo, ...(ehTexto && conteudo !== null ? { conteudo } : {}) })}
          >
            {ocupado ? <Loader2 className="animate-spin" /> : null}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
