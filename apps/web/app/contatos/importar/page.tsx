"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import type { CampoImportacao, ImportJobDTO, LinhaPrevia, Mapeamento, PreviewImportacao, SituacaoLinha } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { PageHeader, SectionHeader } from "@/components/ui/page-header";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSocket } from "@/lib/socket-client";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { cancelImportAction, commitImportAction, getImportJobAction, listImportJobsAction, previewImportAction } from "./actions";

/**
 * Importação de contatos em 4 passos (produto §C): Arquivo → Colunas →
 * Checagem → Importar. O arquivo fica no navegador entre os passos; cada
 * prévia é recalculada no servidor com o mapeamento escolhido. Nada é gravado
 * antes do passo 4, e o passo 4 roda no worker (andamento ao vivo pelo socket).
 */

const PASSOS = ["Arquivo", "Colunas", "Checagem", "Importar"] as const;

/** Rótulos dos campos do contato (tipado contra o core: campo novo lá = erro aqui). */
const ROTULO_CAMPO = {
  nome: "Nome",
  sobrenome: "Sobrenome",
  cpf: "CPF",
  documento: "CPF ou CNPJ (o CRM Agro separa)",
  whatsapp: "WhatsApp / telefone",
  whatsapp2: "Telefone 2",
  email: "E-mail",
  email2: "E-mail 2",
  empresa: "Empresa / fazenda",
  cnpj: "CNPJ da empresa",
  ie: "Inscrição estadual (IE)",
  cidade: "Cidade",
  estado: "Estado (UF)",
  cargo: "Cargo",
  origem: "Origem",
  tags: "Tags",
} satisfies Record<CampoImportacao, string>;
const CAMPOS = Object.keys(ROTULO_CAMPO) as CampoImportacao[];
const NAO_IMPORTAR = "__nao__";

const SITUACAO: Record<SituacaoLinha, { label: string; tone: StatusTone; ajuda: string }> = {
  novo: { label: "Novos", tone: "ok", ajuda: "Contatos que ainda não existem no CRM Agro." },
  ja_existe: { label: "Já existem", tone: "info", ajuda: "Mesmo CPF, WhatsApp ou e-mail de um contato seu." },
  repetido: { label: "Repetidos na planilha", tone: "attention", ajuda: "Mesmo CPF, telefone ou e-mail de uma linha anterior (ficam unidas ao mesmo contato, com as empresas e os telefones somados)." },
  invalido: { label: "Inválidos", tone: "error", ajuda: "Sem nome, ou com telefone, e-mail ou estado que não valem." },
};

const STATUS_JOB: Record<ImportJobDTO["status"], { label: string; tone: StatusTone }> = {
  queued: { label: "Na fila", tone: "info" },
  processing: { label: "Importando", tone: "ok" },
  done: { label: "Concluída", tone: "done" },
  failed: { label: "Falhou", tone: "error" },
  canceled: { label: "Cancelada", tone: "done" },
};

function Passos({ atual }: { atual: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-8 gap-y-2">
      {PASSOS.map((rotulo, i) => {
        const n = i + 1;
        const ativo = n === atual;
        const feito = n < atual;
        return (
          <li key={rotulo} className={cn("num inline-flex items-center gap-2.5 text-body", ativo ? "font-medium text-foreground" : feito ? "text-ink-2" : "text-ink-3")}>
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-caption",
                ativo ? "border-brand-500 bg-brand-500 text-white" : feito ? "border-brand-500 text-brand-500" : "border-line-strong text-ink-3",
              )}
            >
              {n}
            </span>
            {rotulo}
          </li>
        );
      })}
    </ol>
  );
}

function Num({ label, valor, tom }: { label: string; valor: number; tom?: StatusTone }) {
  return (
    <div className="flex flex-col gap-1 py-4 pr-6 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-line [&:not(:first-child)]:pl-6">
      <span className="text-small text-ink-2">{label}</span>
      <span className={cn("num font-serif text-num", tom === "ok" && valor > 0 && "text-success-500", tom === "error" && valor > 0 && "text-danger-500", tom === "attention" && valor > 0 && "text-warning-500")}>
        {valor}
      </span>
    </div>
  );
}

export default function ImportarPage() {
  const [passo, setPasso] = useState(1);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewImportacao | null>(null);
  const [mapeamento, setMapeamento] = useState<Mapeamento>([]);
  const [situacao, setSituacao] = useState<SituacaoLinha | "amostra">("amostra");
  const [origem, setOrigem] = useState("planilha");
  const [existentes, setExistentes] = useState<"completar" | "pular">("completar");
  const [job, setJob] = useState<ImportJobDTO | null>(null);
  const [recentes, setRecentes] = useState<ImportJobDTO[]>([]);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrastando, setArrastando] = useState(false);

  // Ao abrir: se há importação rodando (recarregou a página), volta para ela.
  useEffect(() => {
    listImportJobsAction().then((jobs) => {
      setRecentes(jobs.slice(0, 5));
      const ativa = jobs.find((j) => j.status === "queued" || j.status === "processing");
      if (ativa) {
        setJob(ativa);
        setPasso(4);
      }
    });
  }, []);

  // ── Passo 1 → 2: lê a planilha e sugere o mapeamento ─────────────────────
  function receber(f: File | null) {
    if (!f) return;
    setArquivo(f);
    const fd = new FormData();
    fd.set("file", f);
    start(async () => {
      const r = await previewImportAction(fd);
      if (!r.ok) {
        toast.error("Não consegui ler a planilha", { description: r.error });
        setArquivo(null);
        return;
      }
      setPreview(r.preview);
      setMapeamento(r.preview.mapeamento);
      setPasso(2);
    });
  }

  // ── Passo 2 → 3: recalcula a prévia com o mapeamento escolhido ───────────
  const temNome = mapeamento.includes("nome");
  const temContato = mapeamento.includes("whatsapp") || mapeamento.includes("email");
  function checar() {
    if (!arquivo) return;
    const fd = new FormData();
    fd.set("file", arquivo);
    fd.set("mapeamento", JSON.stringify(mapeamento));
    start(async () => {
      const r = await previewImportAction(fd);
      if (!r.ok) {
        toast.error("Mapeamento recusado", { description: r.error });
        return;
      }
      setPreview(r.preview);
      setSituacao("amostra");
      setPasso(3);
    });
  }

  function trocarColuna(i: number, v: string) {
    setMapeamento((m) => {
      const n = [...m];
      const campo = v === NAO_IMPORTAR ? null : (v as CampoImportacao);
      // Campo único: se outra coluna já ia para ele, essa outra deixa de importar.
      if (campo && campo !== "tags") n.forEach((c, j) => c === campo && j !== i && (n[j] = null));
      n[i] = campo;
      return n;
    });
  }

  // ── Passo 3 → 4: cria o job (o worker importa) ───────────────────────────
  function importar() {
    if (!arquivo) return;
    const fd = new FormData();
    fd.set("file", arquivo);
    fd.set("mapeamento", JSON.stringify(mapeamento));
    fd.set("opcoes", JSON.stringify({ origem: origem.trim() || "planilha", existentes }));
    start(async () => {
      const r = await commitImportAction(fd);
      if (!r.ok) {
        toast.error("A importação não começou", { description: r.error });
        return;
      }
      setJob(r.job);
      setPasso(4);
    });
  }

  // ── Passo 4: andamento ao vivo (socket) + releitura de reserva ───────────
  const jobId = job?.id;
  const encerrado = job ? job.status === "done" || job.status === "failed" || job.status === "canceled" : false;
  const reler = useCallback(async () => {
    if (!jobId) return;
    const r = await getImportJobAction(jobId);
    if (r.ok) setJob(r.job);
  }, [jobId]);
  useSocket({
    "import:progress": (ev) => {
      if (ev.importJobId !== jobId) return;
      setJob((j) => (j ? { ...j, status: ev.status as ImportJobDTO["status"], total: ev.total, processadas: ev.processadas, criadas: ev.criadas, atualizadas: ev.atualizadas, puladas: ev.puladas, invalidas: ev.invalidas } : j));
      if (ev.status === "done" || ev.status === "failed" || ev.status === "canceled") void reler();
    },
  });
  useEffect(() => {
    if (!jobId || encerrado) return;
    const t = setInterval(() => void reler(), 3000);
    return () => clearInterval(t);
  }, [jobId, encerrado, reler]);

  function cancelar() {
    if (!jobId) return;
    start(async () => {
      const r = await cancelImportAction(jobId);
      if (r.ok) setJob(r.job);
      else toast.error("Não deu para cancelar", { description: r.error });
    });
  }

  function recomecar() {
    setPasso(1);
    setArquivo(null);
    setPreview(null);
    setMapeamento([]);
    setJob(null);
    listImportJobsAction().then((jobs) => setRecentes(jobs.slice(0, 5)));
  }

  const linhasVisiveis: LinhaPrevia[] = useMemo(() => {
    if (!preview) return [];
    return situacao === "amostra" ? preview.amostra : preview.exemplos[situacao];
  }, [preview, situacao]);
  const importaveis = preview ? preview.contagens.novos + (existentes === "completar" ? preview.contagens.jaExistem : 0) : 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader breadcrumb={[{ label: "Contatos", href: "/contatos" }]} title="Importar contatos" subtitle={<Passos atual={passo} />} />

      {/* ───────── 1 · Arquivo ───────── */}
      {passo === 1 && (
        <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section>
            <SectionHeader title="Planilha" aside={<span>.xlsx, .xls ou .csv · até 50.000 linhas</span>} />
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setArrastando(true);
              }}
              onDragLeave={() => setArrastando(false)}
              onDrop={(e) => {
                e.preventDefault();
                setArrastando(false);
                receber(e.dataTransfer.files?.[0] ?? null);
              }}
              className={cn(
                "mt-5 flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 text-center transition-colors",
                arrastando ? "border-brand-500 bg-brand-100/40" : "border-line-strong hover:border-ink-3",
              )}
            >
              {pending ? <Loader2 className="h-5 w-5 animate-spin text-ink-3" /> : <Upload className="h-5 w-5 text-ink-3" />}
              <div>
                <p className="text-body font-medium">{pending ? "Lendo a planilha…" : "Solte a planilha aqui ou clique para escolher"}</p>
                <p className="pt-1 text-small text-ink-2">A primeira linha precisa ser o cabeçalho (nome das colunas).</p>
              </div>
              <input ref={inputRef} type="file" accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="hidden" onChange={(e) => receber(e.target.files?.[0] ?? null)} />
            </div>
            <p className="pt-4 text-small leading-relaxed text-ink-2">
              O CRM Agro reconhece as colunas sozinho (nome, WhatsApp, e-mail, empresa, cidade, estado, cargo, origem, tags) e você confere no próximo passo. Nada é gravado antes de você
              confirmar.
            </p>
          </section>

          <aside>
            <SectionHeader variant="aside" title="Importações recentes" />
            {recentes.length === 0 ? (
              <p className="py-4 text-small text-ink-2">Nenhuma ainda.</p>
            ) : (
              <ul className="m-0 list-none p-0">
                {recentes.map((j) => (
                  <li key={j.id} className="flex items-start justify-between gap-3 border-b border-line py-3 text-small">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{j.nomeArquivo}</div>
                      <div className="num text-caption text-ink-3">
                        {formatWhen(j.createdAt)} · {j.criadas} novos{j.atualizadas ? ` · ${j.atualizadas} completados` : ""}
                        {j.invalidas ? ` · ${j.invalidas} inválidos` : ""}
                      </div>
                    </div>
                    <StatusDot tone={STATUS_JOB[j.status].tone}>{STATUS_JOB[j.status].label}</StatusDot>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      {/* ───────── 2 · Colunas ───────── */}
      {passo === 2 && preview && (
        <div className="flex flex-col gap-8">
          <section>
            <SectionHeader
              title="Para onde vai cada coluna"
              aside={
                <span className="num">
                  {arquivo?.name} · {preview.total} linhas · {preview.colunas.length} colunas
                </span>
              }
            />
            <Table className="mt-2">
              <TableHeader>
                <TableRow>
                  <TableHead>Coluna da planilha</TableHead>
                  <TableHead>Exemplos</TableHead>
                  <TableHead className="w-[260px]">Vai para</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.colunas.map((col, i) => {
                  const exemplos = preview.amostra
                    .map((l) => l.valores[i])
                    .filter((v): v is string => Boolean(v))
                    .slice(0, 3);
                  const sugerido = preview.mapeamentoSugerido[i];
                  const atual = mapeamento[i] ?? null;
                  return (
                    <TableRow key={i}>
                      <TableCell className="font-medium">
                        {col || <span className="text-ink-3">(sem nome)</span>}
                        {sugerido && atual === sugerido && <span className="ml-2 text-caption text-ink-3">reconhecida</span>}
                      </TableCell>
                      <TableCell className="text-small text-ink-2">
                        <span className="line-clamp-1">{exemplos.length ? exemplos.join(" · ") : "—"}</span>
                      </TableCell>
                      <TableCell>
                        <Select value={atual ?? NAO_IMPORTAR} onValueChange={(v) => trocarColuna(i, v)}>
                          <SelectTrigger className={cn("h-8", !atual && "text-ink-3")}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NAO_IMPORTAR}>Não importar</SelectItem>
                            {CAMPOS.map((c) => (
                              <SelectItem key={c} value={c}>
                                {ROTULO_CAMPO[c]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>

          {(!temNome || !temContato) && (
            <p className="flex items-start gap-2 text-small text-ink-2">
              <StatusDot tone="attention" className="mt-[3px]" />
              {!temNome ? "Falta dizer qual coluna é o Nome." : "Falta uma coluna de WhatsApp ou de e-mail: sem isso não dá para saber quem já existe."}
            </p>
          )}

          <div className="flex justify-between gap-2 border-t border-line pt-5">
            <Button variant="ghost" onClick={recomecar}>
              Trocar arquivo
            </Button>
            <Button onClick={checar} disabled={pending || !temNome || !temContato}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Checar as linhas
            </Button>
          </div>
        </div>
      )}

      {/* ───────── 3 · Checagem ───────── */}
      {passo === 3 && preview && (
        <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-8">
            <section>
              <SectionHeader title="O que vai acontecer" aside={<span className="num">{preview.total} linhas</span>} />
              <div className="grid grid-cols-2 border-b border-line sm:grid-cols-4">
                <Num label="Novos" valor={preview.contagens.novos} tom="ok" />
                <Num label="Já existem" valor={preview.contagens.jaExistem} tom="info" />
                <Num label="Repetidos" valor={preview.contagens.repetidos} tom="attention" />
                <Num label="Inválidos" valor={preview.contagens.invalidos} tom="error" />
              </div>
              {preview.avisos.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1.5 p-0 pt-4">
                  {preview.avisos.map((a) => (
                    <li key={a} className="flex items-start gap-2 text-small text-ink-2">
                      <StatusDot tone="attention" className="mt-[3px]" />
                      {a}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <div role="tablist" className="flex flex-wrap gap-6 border-b border-line">
                {(["amostra", "novo", "ja_existe", "repetido", "invalido"] as const).map((s) => {
                  const n = s === "amostra" ? preview.amostra.length : preview.exemplos[s].length;
                  const label = s === "amostra" ? "Primeiras linhas" : SITUACAO[s].label;
                  return (
                    <button
                      key={s}
                      type="button"
                      role="tab"
                      aria-selected={situacao === s}
                      onClick={() => setSituacao(s)}
                      className={cn("-mb-px flex h-10 items-center gap-1.5 border-b-2 text-body", situacao === s ? "border-foreground font-medium text-foreground" : "border-transparent text-ink-2 hover:text-foreground")}
                    >
                      {label}
                      <span className="num text-ink-3">{n}</span>
                    </button>
                  );
                })}
              </div>
              {situacao !== "amostra" && <p className="pt-3 text-small text-ink-2">{SITUACAO[situacao].ajuda}</p>}
              {linhasVisiveis.length === 0 ? (
                <p className="py-8 text-small text-ink-2">Nenhuma linha aqui.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table className="mt-2">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-14">Linha</TableHead>
                        <TableHead>Situação</TableHead>
                        {preview.colunas.map((col, i) => mapeamento[i] && <TableHead key={i}>{ROTULO_CAMPO[mapeamento[i]!]}</TableHead>)}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {linhasVisiveis.map((l) => (
                        <TableRow key={l.linha}>
                          <TableCell className="num text-ink-3">{l.linha}</TableCell>
                          <TableCell className="whitespace-nowrap">
                            <StatusDot tone={SITUACAO[l.situacao].tone}>
                              {l.situacao === "invalido" ? l.motivo ?? "Inválido" : l.situacao === "repetido" ? `Repete a linha ${l.repeteLinha}` : l.situacao === "ja_existe" ? "Já existe" : "Novo"}
                            </StatusDot>
                          </TableCell>
                          {preview.colunas.map((_, i) => mapeamento[i] && (
                            <TableCell key={i} className="max-w-[220px] truncate text-small">
                              {l.valores[i] || <span className="text-ink-3">—</span>}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>
          </div>

          <aside className="flex flex-col gap-8">
            <section>
              <SectionHeader variant="aside" title="Quem já existe" />
              <div className="flex flex-col gap-3 pt-4">
                {(
                  [
                    ["completar", "Completar o que está vazio", "e-mail, empresa, cidade… sem apagar nada"],
                    ["pular", "Deixar como está", "a linha da planilha é ignorada"],
                  ] as const
                ).map(([v, l, d]) => (
                  <label key={v} className="flex cursor-pointer items-start gap-3">
                    <input type="radio" name="existentes" value={v} checked={existentes === v} onChange={() => setExistentes(v)} className="mt-1 accent-brand-500" />
                    <span>
                      <span className="block text-body">{l}</span>
                      <span className="block text-caption text-ink-3">{d}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>
            <section>
              <SectionHeader variant="aside" title="Origem" />
              <div className="grid gap-1.5 pt-4">
                <Label htmlFor="origem" className="text-small text-ink-2">
                  Gravada nos contatos que não têm coluna de origem
                </Label>
                <Input id="origem" value={origem} onChange={(e) => setOrigem(e.target.value)} maxLength={60} placeholder="planilha" />
              </div>
            </section>
            <div className="flex flex-col gap-3 border-t border-line pt-5">
              <Button onClick={importar} disabled={pending || importaveis === 0}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Importar {importaveis} {importaveis === 1 ? "contato" : "contatos"}
              </Button>
              <Button variant="ghost" onClick={() => setPasso(2)} disabled={pending}>
                Voltar às colunas
              </Button>
              <p className="text-caption text-ink-3">Roda em segundo plano; você pode sair da tela.</p>
            </div>
          </aside>
        </div>
      )}

      {/* ───────── 4 · Importar ───────── */}
      {passo === 4 && job && (
        <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex flex-col gap-8">
            <section>
              <SectionHeader
                title={
                  <span className="inline-flex items-baseline gap-4">
                    {job.nomeArquivo}
                    <StatusDot tone={STATUS_JOB[job.status].tone}>{STATUS_JOB[job.status].label}</StatusDot>
                  </span>
                }
                aside={
                  <span className="num">
                    {job.processadas} de {job.total}
                  </span>
                }
              />
              <Progress value={job.total ? (job.processadas / job.total) * 100 : job.status === "done" ? 100 : 0} className="mt-5" />
              <div className="grid grid-cols-2 border-b border-line sm:grid-cols-4">
                <Num label="Criados" valor={job.criadas} tom="ok" />
                <Num label="Completados" valor={job.atualizadas} tom="info" />
                <Num label="Pulados" valor={job.puladas} />
                <Num label="Inválidos" valor={job.invalidas} tom="error" />
              </div>
              {job.status === "failed" && (
                <p className="flex items-start gap-2 pt-4 text-small text-danger-500">
                  <StatusDot tone="error" className="mt-[3px]" />A importação parou por um erro. O que já entrou ficou; tente de novo com o mesmo arquivo.
                </p>
              )}
            </section>

            {job.erros.length > 0 && (
              <section>
                <SectionHeader title="Linhas recusadas" aside={<span className="num">amostra de {job.erros.length}</span>} />
                <Table className="mt-2">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Linha</TableHead>
                      <TableHead>Motivo</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {job.erros.map((e) => (
                      <TableRow key={e.linha}>
                        <TableCell className="num text-ink-3">{e.linha}</TableCell>
                        <TableCell className="text-small">{e.motivo}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
            )}
          </div>

          <aside className="flex flex-col gap-3 border-t border-line pt-5 lg:border-t-0 lg:pt-0">
            {encerrado ? (
              <>
                <Button asChild>
                  <Link href="/contatos">Ver os contatos</Link>
                </Button>
                <Button variant="outline" onClick={recomecar}>
                  Importar outra planilha
                </Button>
              </>
            ) : (
              <>
                <p className="flex items-center gap-2 text-small text-ink-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importando em segundo plano…
                </p>
                <Button variant="ghost" className="justify-start text-danger-500 hover:text-danger-700" onClick={cancelar} disabled={pending}>
                  Cancelar o restante
                </Button>
                <p className="text-caption text-ink-3">O que já entrou fica.</p>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
