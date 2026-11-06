"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Plus, Trash2, X, Info } from "lucide-react";
import { listFlowsForSwitchAction } from "../actions";
import { listAssinaturasParaFluxoAction } from "../actions";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { criterioLabel, CRITERIO_LABELS } from "./serialize";
import type { BranchDef, NodeData } from "./serialize";
import { SeletorDeTag } from "./SeletorDeTag";

type Target = { id: string; label: string };

type Props = {
  data: NodeData;
  onChange: (next: NodeData) => void;
  targets: Target[]; // outros nós (para selects de destino)
  funnels: { id: string; nome: string; stages: { id: string; nome: string }[] }[];
  accounts: { id: string; label: string }[];
  /** Metodologias do agente de IA (a padrão da empresa vem marcada). */
  metodologias: { id: string; nome: string; padrao: boolean }[];
};

function TargetSelect({
  value,
  targets,
  onChange,
}: {
  value: string | null | undefined;
  targets: Target[];
  onChange: (v: string | null) => void;
}) {
  return (
    <Select value={value ?? "__end__"} onValueChange={(v) => onChange(v === "__end__" ? null : v)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__end__">Terminar o fluxo</SelectItem>
        {targets.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ConfigPanel({ data, onChange, targets, funnels, accounts, metodologias }: Props) {
  const set = (patch: Partial<NodeData>) => onChange({ ...data, ...patch });
  const stages = funnels.find((f) => f.id === data.funnelId)?.stages ?? [];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label className="text-caption text-muted-foreground">Tipo</Label>
        <p className="text-sm font-medium">{data.label}</p>
      </div>

      {data.tipo === "send_message" && (
        <>
          <div className="space-y-1">
            <Label>Conta WhatsApp</Label>
            <Select value={data.channelAccountId ?? "__default__"} onValueChange={(v) => set({ channelAccountId: v === "__default__" ? undefined : v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">Padrão (1ª conectada)</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Mensagem</Label>
            <Textarea value={data.text ?? ""} onChange={(e) => set({ text: e.target.value })} rows={4} placeholder="{saudacao}! Tudo bem?" />
            <p className="text-xs text-muted-foreground/70">
              Variáveis: <code>{"{saudacao}"}</code> (bom dia/tarde/noite), <code>{"{primeiro_nome}"}</code>,{" "}
              <code>{"{nome}"}</code>, <code>{"{sobrenome}"}</code>, <code>{"{empresa}"}</code>,{" "}
              <code>{"{cargo}"}</code>, <code>{"{cidade}"}</code>, <code>{"{estado}"}</code>,{" "}
              <code>{"{cnpj}"}</code>, <code>{"{site}"}</code>, <code>{"{email}"}</code>,{" "}
              <code>{"{telefone}"}</code>, <code>{"{instagram}"}</code>, <code>{"{linkedin}"}</code>. Empresa:{" "}
              <code>{"{empresa}"}</code>, <code>{"{empresa_cnpj}"}</code>, <code>{"{ie}"}</code>,{" "}
              <code>{"{empresa_cidade}"}</code>, <code>{"{empresa_estado}"}</code>, <code>{"{empresa_site}"}</code>,{" "}
              <code>{"{empresa_telefone}"}</code>, <code>{"{empresa_email}"}</code>. Fallback:{" "}
              <code>{"{empresa|sua empresa}"}</code>. Variável sem valor some do texto.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={!!data.skipIfHistory} onCheckedChange={(v) => set({ skipIfHistory: v === true })} />
            Não enviar se já houver conversa fora da plataforma
          </label>
          {data.skipIfHistory && (
            <div className="space-y-1 pl-6">
              <Label>Quando houver histórico</Label>
              <Select
                value={data.onHistory ?? "skip"}
                onValueChange={(v: "skip" | "hold") => set({ onHistory: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">Pular o envio e seguir</SelectItem>
                  <SelectItem value="hold">Marcar “Tem Histórico” e segurar p/ revisão</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground/70">
                Revenda: “segurar” trava o contato na aba Histórico para você decidir.
              </p>
            </div>
          )}
          <p className="text-xs text-muted-foreground/70">
            Próximo passo: arraste uma conexão da bolinha à direita do bloco.
          </p>
        </>
      )}

      {data.tipo === "send_email" && (
        <>
          <div className="space-y-1">
            <Label>Assunto</Label>
            <Input value={data.subject ?? ""} onChange={(e) => set({ subject: e.target.value })} placeholder="{saudacao}, {primeiro_nome}!" />
          </div>
          <div className="space-y-1">
            <Label>Corpo</Label>
            <Textarea value={data.text ?? ""} onChange={(e) => set({ text: e.target.value })} rows={6} placeholder="Escreva o e-mail…" />
            <p className="text-xs text-muted-foreground/70">
              Mesmas variáveis da mensagem ({"{saudacao}"}, {"{primeiro_nome}"}, {"{empresa}"}, …). Envia
              pela conta de e-mail conectada em Integrações → Canais → E-mail.
            </p>
          </div>
          <div className="space-y-1">
            <Label>Assinatura</Label>
            <EmailSignaturePicker value={data.emailSignatureId ?? ""} onChange={(id) => set({ emailSignatureId: id || undefined })} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={data.skipIfNoEmail ?? true} onCheckedChange={(v) => set({ skipIfNoEmail: v === true })} />
            Pular se o contato não tiver e-mail
          </label>
        </>
      )}

      {data.tipo === "send_social" && (
        <>
          <div className="space-y-1">
            <Label>Canal</Label>
            <div className="flex gap-2">
              {(["instagram", "linkedin"] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => set({ socialCanal: c })}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm capitalize " +
                    ((data.socialCanal ?? "instagram") === c
                      ? "border-brand-500 bg-brand-100/40 font-medium"
                      : "border-border hover:bg-muted/50")
                  }
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label>Mensagem</Label>
            <Textarea value={data.text ?? ""} onChange={(e) => set({ text: e.target.value })} rows={5} placeholder="Escreva o DM…" />
            <p className="text-xs text-muted-foreground/70">
              Mesmas variáveis ({"{primeiro_nome}"}, {"{empresa}"}, …). Envia pela conta conectada em
              Integrações → Canais. ⚠️ Automação não-oficial: respeita o limite diário e o aquecimento.
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label>Se o contato não tiver {(data.socialCanal ?? "instagram") === "linkedin" ? "LinkedIn" : "Instagram"}</Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Ajuda">
                    <Info className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p><strong>Pular:</strong> segue o fluxo normalmente (não envia nada neste passo).</p>
                  <p className="mt-1"><strong>Segurar:</strong> o contato <em>não avança</em>: fica parado aqui esperando você resolver o handle e dar o OK manual. Use quando não quer que ele passe adiante sem ter enviado.</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex gap-2">
              {([["skip", "Pular"], ["hold", "Segurar p/ OK manual"]] as const).map(([v, lbl]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => set({ onNoHandle: v })}
                  className={
                    "rounded-md border px-3 py-1.5 text-sm " +
                    ((data.onNoHandle ?? "skip") === v
                      ? "border-brand-500 bg-brand-100/40 font-medium"
                      : "border-border hover:bg-muted/50")
                  }
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5 rounded-md border border-dashed p-2.5">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={Boolean(data.aiPersonalize)}
                onChange={(e) => set({ aiPersonalize: e.target.checked })}
              />
              <span className="text-sm">
                Variar o texto com IA
                <span className="block text-xs text-muted-foreground/70">
                  A IA reescreve a mensagem variando o texto por contato, mantendo a intenção.
                  Requer a IA conectada em Integrações → IA; se falhar,
                  envia o texto original.
                </span>
              </span>
            </label>
            {data.aiPersonalize && (
              <div className="space-y-1 pl-6">
                <Label>Orientação para a IA (opcional)</Label>
                <Textarea
                  value={data.aiInstrucao ?? ""}
                  onChange={(e) => set({ aiInstrucao: e.target.value })}
                  rows={2}
                  placeholder="Tom, objetivo, o que evitar…"
                />
              </div>
            )}
          </div>
        </>
      )}

      {data.tipo === "switch_flow" && (
        <div className="space-y-1">
          <Label>Fluxo de destino</Label>
          <SwitchFlowPicker value={data.switchFlowId ?? ""} onChange={(id) => set({ switchFlowId: id })} />
          <p className="text-xs text-muted-foreground/70">
            O contato é inscrito no fluxo escolhido e o fluxo atual <strong>encerra</strong> para ele. Ideal
            no “senão” de uma condição (ex.: já tem histórico → manda pro fluxo de reativação).
          </p>
        </div>
      )}

      {data.tipo === "manual_call" && (
        <>
          <div className="space-y-1">
            <Label>Roteiro da ligação (opcional)</Label>
            <Textarea
              value={data.roteiro ?? ""}
              onChange={(e) => set({ roteiro: e.target.value })}
              rows={4}
              placeholder="O que falar na ligação…"
            />
          </div>
          <p className="text-xs text-muted-foreground/70">
            Este passo <strong>trava o fluxo</strong>: o contato fica pendente na aba Histórico até
            você marcar a ligação como feita (com resumo e observação). Só então o fluxo avança.
          </p>
        </>
      )}

      {data.tipo === "sync_name" && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={!!data.overwrite} onCheckedChange={(v) => set({ overwrite: v === true })} />
            Sobrescrever o nome atual (mesmo se já houver um)
          </label>
          <p className="text-xs text-muted-foreground/70">
            Puxa o <strong>nome do WhatsApp</strong> (pushName) que o contato expôs ao responder e
            preenche o cadastro se ainda não houver nome real. Coloque este passo <strong>depois</strong>{" "}
            de o contato responder. As mensagens seguintes podem usar <code>{"{primeiro_nome}"}</code>.
          </p>
        </>
      )}

      {data.tipo === "enrich_data" && (
        <div className="space-y-2">
          <p className="flex items-start gap-2 rounded-md border border-warning-500/30 bg-warning-100 p-2 text-xs text-warning-700" role="status">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Este passo é <strong>antigo</strong> e continua funcionando como sempre. Troque por um dos dois novos, que guardam a fonte e a data de
              cada dado.
            </span>
          </p>
          <p className="text-xs text-muted-foreground/70">
            Consulta o <strong>CNPJ</strong> das empresas do contato e preenche o que estiver <strong>vazio</strong> (IE, e-mail, telefone,
            endereço, cidade, UF, CNAE). Nunca troca o que já está preenchido.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => set({ tipo: "enrich_company", label: "Enriquecer empresa" })}>
              Trocar por Enriquecer empresa
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => set({ tipo: "enrich_person", label: "Enriquecer pessoa", incluirConfiancaMedia: false })}>
              Trocar por Enriquecer pessoa
            </Button>
          </div>
        </div>
      )}

      {data.tipo === "enrich_company" && (
        <p className="text-xs text-muted-foreground/70">
          Consulta o <strong>CNPJ</strong> de cada empresa do contato e preenche só o que estiver <strong>vazio</strong> (e-mail, telefone, IE,
          endereço, cidade, UF, CNAE, natureza jurídica), com a <strong>fonte e a data</strong> de cada dado. Nunca troca o que já está
          preenchido e não guarda o e-mail do contador. Para ler o site da empresa e trocar valores, use o botão Enriquecer empresa na ficha do
          contato. Sem empresa ou sem CNPJ o passo pula e o histórico do fluxo mostra o motivo.
        </p>
      )}

      {data.tipo === "enrich_person" && (
        <>
          <p className="text-xs text-muted-foreground/70">
            Com o <strong>CPF guardado</strong> no contato e o nome e sobrenome, acha as empresas em que ele é <strong>sócio ou dono</strong> (fonte
            gratuita da Receita) e vincula ao contato. Vincula só quando o CPF e o nome conferem. Sem CPF no cadastro o passo pula e o histórico do
            fluxo mostra o motivo. Este passo <strong>nunca consulta fonte paga</strong>: a inscrição estadual de produtor rural fica para o botão
            Enriquecer pessoa na ficha, com o custo à vista.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={!!data.incluirConfiancaMedia} onCheckedChange={(v) => set({ incluirConfiancaMedia: v === true })} />
            Vincular também quando o nome é parecido (confiança média)
          </label>
        </>
      )}

      {data.tipo === "save_history" && (
        <>
          <p className="text-xs text-muted-foreground/70">
            Pega a <strong>conversa inteira</strong> do contato no WhatsApp (tenha ele respondido ou não) e registra no{" "}
            <strong>histórico do contato</strong>. Rodar de novo só acrescenta o que faltava. O contato precisa ter{" "}
            <strong>número de WhatsApp cadastrado</strong>: sem ele o passo fica segurado como “sem cadastro” no histórico do fluxo.
            Cadastre o número e retome.
          </p>
          <div className="space-y-1">
            <Label>Número de WhatsApp (opcional)</Label>
            <Select value={data.channelAccountId ?? "auto"} onValueChange={(v) => set({ channelAccountId: v === "auto" ? undefined : v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Automático (todos os números)</SelectItem>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {data.tipo === "wait" && (
        <>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label>{data.durationMax != null ? "Mínimo" : "Duração"}</Label>
              <Input type="number" min={1} value={data.duration ?? 1} onChange={(e) => set({ duration: Number(e.target.value) })} />
            </div>
            {data.durationMax != null && (
              <div className="flex-1 space-y-1">
                <Label>Máximo</Label>
                <Input
                  type="number"
                  min={data.duration ?? 1}
                  value={data.durationMax}
                  onChange={(e) => set({ durationMax: Number(e.target.value) })}
                />
              </div>
            )}
            <div className="w-24 space-y-1">
              <Label>Unidade</Label>
              <Select
                value={data.unit ?? "hour"}
                onValueChange={(v: "sec" | "min" | "hour" | "day") => set({ unit: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sec">seg</SelectItem>
                  <SelectItem value="min">min</SelectItem>
                  <SelectItem value="hour">hora</SelectItem>
                  <SelectItem value="day">dia</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={data.durationMax != null}
              onCheckedChange={(v) =>
                set({ durationMax: v === true ? Math.max((data.duration ?? 1) + 1, (data.duration ?? 1) * 2) : null })
              }
            />
            Intercalar (espera aleatória entre mín. e máx.)
          </label>
          {data.durationMax != null && (
            <p className="text-xs text-muted-foreground">
              Cada contato espera um tempo sorteado nesse intervalo. Isso evita padrão fixo de envio.
            </p>
          )}
          <p className="text-xs text-muted-foreground/70">
            Próximo passo: arraste uma conexão da bolinha à direita do bloco.
          </p>
        </>
      )}

      {data.tipo === "typing" && (
        <>
          <p className="text-xs text-muted-foreground">
            Mostra “digitando…” no canal (WhatsApp; Instagram/LinkedIn quando conectados) pelo tempo abaixo e então segue para o próximo passo. Use antes de um “Enviar mensagem” para humanizar a cadência. Não trava os outros fluxos.
          </p>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label>{data.durationMax != null ? "Mínimo" : "Duração"}</Label>
              <Input type="number" min={1} value={data.duration ?? 30} onChange={(e) => set({ duration: Number(e.target.value) })} />
            </div>
            {data.durationMax != null && (
              <div className="flex-1 space-y-1">
                <Label>Máximo</Label>
                <Input
                  type="number"
                  min={data.duration ?? 30}
                  value={data.durationMax}
                  onChange={(e) => set({ durationMax: Number(e.target.value) })}
                />
              </div>
            )}
            <div className="w-24 space-y-1">
              <Label>Unidade</Label>
              <Select value={data.unit === "min" ? "min" : "sec"} onValueChange={(v: "sec" | "min") => set({ unit: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sec">seg</SelectItem>
                  <SelectItem value="min">min</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={data.durationMax != null}
              onCheckedChange={(v) =>
                set({ durationMax: v === true ? Math.max((data.duration ?? 30) + 1, (data.duration ?? 30) * 2) : null })
              }
            />
            Tempo aleatório (entre mín. e máx.)
          </label>
          {data.durationMax != null && (
            <p className="text-xs text-muted-foreground">
              O “digitando” dura um tempo sorteado nesse intervalo. Isso evita padrão fixo e ajuda a não ser bloqueado.
            </p>
          )}
          <p className="text-xs text-muted-foreground/70">
            Próximo passo: arraste uma conexão da bolinha à direita do bloco.
          </p>
        </>
      )}

      {data.tipo === "condition" && (
        <>
          <div className="space-y-2">
            <Label>Ramos</Label>
            <p className="text-xs text-muted-foreground/70">
              O destino de cada ramo é a <strong>conexão</strong> que você puxa da bolinha à direita
              dele no mapa. O rótulo acompanha o critério (e você pode editá-lo).
            </p>
            {(data.branches ?? []).map((b, i) => (
              <BranchEditor
                key={b.id}
                branch={b}
                funnels={funnels}
                onChange={(nb) => {
                  const branches = [...(data.branches ?? [])];
                  branches[i] = nb;
                  set({ branches });
                }}
                onRemove={() => {
                  const branches = (data.branches ?? []).filter((_, j) => j !== i);
                  set({ branches });
                }}
              />
            ))}
            <Button variant="outline" size="sm" onClick={() => set({ branches: [...(data.branches ?? []), { id: `b_${Math.random().toString(36).slice(2, 8)}`, label: "Respondeu", condition: { type: "responded", janelaMin: 60 }, nextNodeId: null }] })}>
              <Plus className="mr-1.5 h-4 w-4" />
              Ramo
            </Button>
          </div>
          <div className="space-y-1">
            <Label>Padrão (senão)</Label>
            <TargetSelect value={data.defaultNext} targets={targets} onChange={(v) => set({ defaultNext: v })} />
            <p className="text-xs text-muted-foreground/70">
              Uma saída pode ir para vários passos: puxe mais de uma conexão da mesma bolinha. Todos começam ao mesmo tempo e cada um
              segue o próprio caminho (uma espera num não segura os outros). Para um depois do outro, ligue um no outro.
            </p>
          </div>
        </>
      )}

      {data.tipo === "ab_split" && (
        <>
          <p className="text-xs text-muted-foreground">
            Divide os contatos entre as variantes por PESO (não precisa somar 100). Cada contato cai
            sempre na mesma variante (sorteio fixo por inscrição). Ligue a saída de cada variante ao
            próximo passo pelas bolinhas à direita.
          </p>
          {(() => {
            const variants = data.variants ?? [];
            const total = variants.reduce((s, v) => s + Math.max(0, v.weight), 0) || 1;
            const setVariants = (vs: typeof variants) => set({ variants: vs });
            return (
              <>
                {variants.map((v, i) => (
                  <div key={v.id} className="flex items-center gap-1.5">
                    <Input
                      value={v.label}
                      onChange={(e) =>
                        setVariants(variants.map((x) => (x.id === v.id ? { ...x, label: e.target.value } : x)))
                      }
                      placeholder={`Variante ${i + 1}`}
                      className="h-8 flex-1"
                    />
                    <Input
                      type="number"
                      min={0}
                      value={v.weight}
                      onChange={(e) =>
                        setVariants(
                          variants.map((x) => (x.id === v.id ? { ...x, weight: Math.max(0, Number(e.target.value) || 0) } : x)),
                        )
                      }
                      className="h-8 w-16"
                    />
                    <span className="w-10 text-right text-caption text-muted-foreground">
                      {Math.round((Math.max(0, v.weight) / total) * 100)}%
                    </span>
                    <Button
                      type="button"
                      variant="ghost-subtle"
                      size="icon-sm"
                      onClick={() => setVariants(variants.filter((x) => x.id !== v.id))}
                      disabled={variants.length <= 2}
                      aria-label="Remover variante"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setVariants([
                      ...variants,
                      { id: `n_${Math.random().toString(36).slice(2, 10)}`, label: String.fromCharCode(65 + variants.length), weight: 0, nextNodeId: null },
                    ])
                  }
                >
                  + Variante
                </Button>
              </>
            );
          })()}
        </>
      )}

      {(data.tipo === "update_stage" || data.tipo === "create_deal") && (
        <>
          <p className="text-xs text-muted-foreground">
            {data.tipo === "create_deal"
              ? "Cria um card do contato neste funil/etapa, SE ele ainda não tiver um negócio aberto aqui (1 por funil)."
              : "MOVE o negócio aberto do contato neste funil para a etapa escolhida. Não cria: use 'Criar card' antes se precisar."}
          </p>
          <div className="space-y-1">
            <Label>Funil</Label>
            <Select value={data.funnelId ?? ""} onValueChange={(v) => set({ funnelId: v, stageId: undefined })}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione o funil" />
              </SelectTrigger>
              <SelectContent>
                {funnels.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Etapa</Label>
            <Select value={data.stageId ?? ""} onValueChange={(v) => set({ stageId: v })} disabled={!stages.length}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione a etapa" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.nome}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground/70">
            Próximo passo: arraste uma conexão da bolinha à direita do bloco.
          </p>
        </>
      )}

      {data.tipo === "add_tag" && (
        <>
          <div className="space-y-1">
            <Label htmlFor="tag-do-passo">Tag</Label>
            <SeletorDeTag id="tag-do-passo" value={data.tag ?? ""} onChange={(t) => set({ tag: t?.nome ?? "" })} />
            {!data.tag && <p className="text-xs text-warning-600">Escolha a tag que este passo vai adicionar.</p>}
          </div>
          <p className="text-xs text-muted-foreground/70">
            Escolha uma tag que já existe ou crie uma nova. A tag nova entra no catálogo do time e aparece em Contatos e
            nos outros seletores.
          </p>
          <p className="text-xs text-muted-foreground/70">
            Próximo passo: arraste uma conexão da bolinha à direita do bloco.
          </p>
        </>
      )}

      {data.tipo === "notify_user" && (
        <>
          <div className="space-y-1">
            <Label>Mensagem</Label>
            <Textarea value={data.message ?? ""} onChange={(e) => set({ message: e.target.value })} rows={3} />
          </div>
          <p className="text-xs text-muted-foreground/70">
            Próximo passo: arraste uma conexão da bolinha à direita do bloco.
          </p>
        </>
      )}

      {data.tipo === "http_request" && (
        <>
          <div className="flex gap-2">
            <div className="w-28 space-y-1">
              <Label>Método</Label>
              <Select value={data.method ?? "POST"} onValueChange={(v) => set({ method: v as NodeData["method"] })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 space-y-1">
              <Label>URL</Label>
              <Input value={data.url ?? ""} onChange={(e) => set({ url: e.target.value })} placeholder="https://" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Body (JSON)</Label>
            <Textarea value={data.body ?? ""} onChange={(e) => set({ body: e.target.value })} rows={3} />
          </div>
          <p className="text-xs text-muted-foreground/70">
            Próximo passo: arraste uma conexão da bolinha à direita do bloco.
          </p>
        </>
      )}

      {data.tipo === "ai_agent" && <AgenteIaPanel data={data} set={set} metodologias={metodologias} />}
    </div>
  );
}

const MODOS_DO_AGENTE: { value: "conversa" | "mensagem"; label: string; ajuda: string }[] = [
  {
    value: "conversa",
    label: "Conversar com o contato",
    ajuda:
      "O agente abre a conversa, espera a resposta, lê o histórico e responde, seguindo a sua orientação. Passa para uma pessoa quando precisar, e o fluxo segue.",
  },
  {
    value: "mensagem",
    label: "Enviar uma mensagem",
    ajuda:
      "A IA escreve uma mensagem personalizada com os dados do contato e o histórico da conversa e envia uma vez. Se a IA falhar, envia o texto de segurança.",
  },
];

/** Painel do nó "Agente IA": conversa com o contato ou uma mensagem personalizada. */
function AgenteIaPanel({ data, set, metodologias }: { data: NodeData; set: (patch: Partial<NodeData>) => void; metodologias: Props["metodologias"] }) {
  const modo = data.aiModo ?? "mensagem";
  const meta = MODOS_DO_AGENTE.find((m) => m.value === modo) ?? MODOS_DO_AGENTE[1]!;
  return (
    <>
      <div className="space-y-1">
        <Label>O que o agente faz</Label>
        <Select value={modo} onValueChange={(v: "conversa" | "mensagem") => set({ aiModo: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODOS_DO_AGENTE.map((m) => (
              <SelectItem key={m.value} value={m.value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-caption text-ink-3">{meta.ajuda}</p>
      </div>

      {modo === "conversa" ? (
        <>
          <div className="space-y-1">
            <Label>Orientação</Label>
            <Textarea
              rows={7}
              value={data.orientacao ?? ""}
              onChange={(e) => set({ orientacao: e.target.value })}
              placeholder="Ex.: Você é do time comercial da Agro Sol. Apresente o adubo foliar e proponha uma conversa de 15 minutos. Se pedirem preço ou quiserem fechar, passe para uma pessoa."
            />
            <p className="text-caption text-ink-3">
              Diga quem é o agente, o que ele quer alcançar, o que pode e o que não pode dizer, e quando passar para uma pessoa. Ele monta a abordagem com o que
              está aqui, o cadastro e o histórico do contato e a base de conhecimento da empresa (Integrações, aba IA).
            </p>
            {!(data.orientacao ?? "").trim() && <p className="text-caption text-warning-600">O fluxo não pode ser ativado sem a orientação.</p>}
          </div>
          <div className="space-y-1">
            <Label>Tom</Label>
            <Input value={data.tom ?? ""} onChange={(e) => set({ tom: e.target.value })} placeholder="Ex.: cordial e direto, consultivo" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-caption">Máximo de mensagens</Label>
              <Input
                type="number"
                min={1}
                max={30}
                value={data.maxRespostas ?? 6}
                onChange={(e) => set({ maxRespostas: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-caption">Esperar resposta (horas)</Label>
              <Input
                type="number"
                min={1}
                max={168}
                value={data.silencioHoras ?? 24}
                onChange={(e) => set({ silencioHoras: Math.min(168, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </div>
          </div>
          <p className="text-caption text-ink-3">
            O agente para quando o contato fica sem responder pelo prazo, quando as mensagens acabam, quando uma pessoa responde na conversa ou quando o contato pede
            para sair. Aí o fluxo segue para o próximo passo.
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-small">
            <Checkbox checked={data.avisarVendedor ?? true} onCheckedChange={(v) => set({ avisarVendedor: v === true })} />
            Avisar o vendedor quando o agente passar a conversa
          </label>
        </>
      ) : (
        <>
          <div className="space-y-1">
            <Label>Objetivo da mensagem</Label>
            <Textarea
              rows={3}
              value={data.objetivo ?? ""}
              onChange={(e) => set({ objetivo: e.target.value })}
              placeholder="Ex.: apresentar a consultoria e propor uma conversa rápida de 15 min."
            />
          </div>
          <div className="space-y-1">
            <Label>Tom</Label>
            <Input value={data.tom ?? ""} onChange={(e) => set({ tom: e.target.value })} placeholder="Ex.: cordial e direto, consultivo" />
          </div>
          <div className="space-y-1">
            <Label>Texto de segurança</Label>
            <Textarea
              rows={2}
              value={data.aiFallbackText ?? ""}
              onChange={(e) => set({ aiFallbackText: e.target.value })}
              placeholder="Ex.: {saudacao}! Posso te mandar uma informação rápida por aqui?"
            />
            <p className="text-caption text-ink-3">
              Enviado quando a IA está desligada, sem chave ou falha. Aceita variáveis ({"{saudacao}"}, {"{primeiro_nome}"}, …). Em branco, usa um padrão neutro.
            </p>
          </div>
        </>
      )}

      <div className="space-y-1">
        <Label>Metodologia</Label>
        <Select value={data.metodologiaId ?? "padrao"} onValueChange={(v) => set({ metodologiaId: v === "padrao" ? undefined : v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="padrao">{metodologias.find((m) => m.padrao) ? `Padrão da empresa (${metodologias.find((m) => m.padrao)!.nome})` : "Padrão da empresa"}</SelectItem>
            {metodologias.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.nome}
              </SelectItem>
            ))}
            <SelectItem value="nenhuma">Sem metodologia</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-caption text-ink-3">
          Como o agente conduz a abordagem, por exemplo o SPIN Selling. Edite e escolha a padrão em Integrações, aba IA, Metodologias. O que ele diz vem do
          objetivo deste passo.
        </p>
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-small">
        <Checkbox checked={data.skipIfHistory ?? false} onCheckedChange={(v) => set({ skipIfHistory: v === true })} />
        {modo === "conversa" ? "Não abrir a conversa se já houver conversa fora da plataforma" : "Não enviar se já houver conversa fora da plataforma"}
      </label>

      <div className="space-y-1">
        <Label>Provedor (opcional)</Label>
        <Select value={data.provider ?? "auto"} onValueChange={(v: "auto" | "anthropic" | "glm") => set({ provider: v === "auto" ? undefined : v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Automático (1º conectado)</SelectItem>
            <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
            <SelectItem value="glm">Z.AI (GLM)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-caption text-ink-3">A chave do provedor e o liga e desliga da IA ficam em Integrações, na aba IA. O agente só envia pelo WhatsApp e respeita o horário de envio do fluxo.</p>
    </>
  );
}

function BranchEditor({
  branch,
  funnels,
  onChange,
  onRemove,
}: {
  branch: BranchDef;
  funnels: { id: string; nome: string; stages: { id: string; nome: string }[] }[];
  onChange: (b: BranchDef) => void;
  onRemove: () => void;
}) {
  const cond = branch.condition;
  // Rótulo dinâmico (item 9): ao trocar o critério (ou o canal), re-sincroniza o
  // rótulo do ramo com o critério — MAS só quando o rótulo atual é auto-gerado
  // (ou vazio). Se o usuário digitou um rótulo próprio, ele é preservado.
  const applyCond = (condition: BranchDef["condition"]) => {
    const cur = branch.label.trim();
    const auto = cur === "" || CRITERIO_LABELS.has(cur);
    onChange({ ...branch, condition, label: auto ? criterioLabel(condition) : branch.label });
  };
  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex gap-2">
        <Input
          className="flex-1"
          value={branch.label}
          onChange={(e) => onChange({ ...branch, label: e.target.value })}
          placeholder="Rótulo"
        />
        <Button variant="ghost" size="icon" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      <Select
        value={cond.type}
        onValueChange={(v) => {
          const type = v as BranchDef["condition"]["type"];
          if (type === "responded") applyCond({ type: "responded", janelaMin: 60 });
          else if (type === "tag_present") applyCond({ type: "tag_present", tag: "" });
          else if (type === "has_name") applyCond({ type: "has_name" });
          else if (type === "whatsapp_name") applyCond({ type: "whatsapp_name" });
          else if (type === "has_whatsapp") applyCond({ type: "has_whatsapp" });
          else if (type === "has_email") applyCond({ type: "has_email" });
          else if (type === "channel_history") applyCond({ type: "channel_history", canal: "whatsapp" });
          else if (type === "has_reply") applyCond({ type: "has_reply" });
          else if (type === "reply_class") applyCond({ type: "reply_class", classe: "sem_interesse" });
          else if (type === "reply_text") applyCond({ type: "reply_text", texto: "", modo: "contem" });
          else applyCond({ type: "stage_is", stageId: "" });
        }}
      >
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="responded">Respondeu desde último envio</SelectItem>
          <SelectItem value="tag_present">Tem tag</SelectItem>
          <SelectItem value="stage_is">Está na etapa</SelectItem>
          <SelectItem value="has_name">Tem nome no cadastro</SelectItem>
          <SelectItem value="whatsapp_name">Tem nome no WhatsApp</SelectItem>
          <SelectItem value="has_whatsapp">Tem WhatsApp</SelectItem>
          <SelectItem value="has_email">Tem e-mail</SelectItem>
          <SelectItem value="channel_history">Já tenho histórico no canal</SelectItem>
          <SelectItem value="has_reply">Já respondeu (recebeu resposta)</SelectItem>
          <SelectItem value="reply_class">A resposta foi: sem interesse, tenho interesse ou outra</SelectItem>
          <SelectItem value="reply_text">A resposta tem uma palavra minha</SelectItem>
        </SelectContent>
      </Select>
      {cond.type === "whatsapp_name" && (
        <p className="text-xs text-muted-foreground/70">
          Ramifica se o WhatsApp do contato tem um <strong>nome de verdade</strong>: o que você salvou na agenda do celular ou o nome do
          perfil (sem emoji, símbolo ou letra solta). O nome do perfil só aparece depois que o contato interage. Use no “Sim” o passo
          Atualizar nome e a mensagem com o primeiro nome; no “senão”, a mensagem genérica.
        </p>
      )}
      {cond.type === "has_whatsapp" && (
        <div className="space-y-1">
          <Label className="text-caption">Como conferir</Label>
          <Select
            value={cond.modo === "verificar" ? "verificar" : "cadastro"}
            // O modo "No cadastro" é o padrão e não é gravado: o fluxo que já existe mantém o mesmo grafo.
            onValueChange={(v) => applyCond(v === "verificar" ? { type: "has_whatsapp", modo: "verificar" } : { type: "has_whatsapp" })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cadastro">No cadastro (grátis, na hora)</SelectItem>
              <SelectItem value="verificar">Conferir no WhatsApp (consulta de verdade)</SelectItem>
            </SelectContent>
          </Select>
          {cond.modo === "verificar" ? (
            <p className="text-xs text-muted-foreground/70">
              Pergunta ao WhatsApp se o número que o passo Enviar mensagem usaria <strong>tem conta</strong>, sem mandar mensagem. Gasta a
              cota diária de consultas da conta (a mesma das campanhas) e espera alguns segundos entre uma consulta e outra, então uma
              lista grande demora. Fora do horário de envio do fluxo, o passo espera. Se o WhatsApp não responder, o CRM Agro tenta de novo
              e, no fim, segura o contato para você decidir no Histórico. O “não” só muda o caminho: não marca o número como errado.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground/70">
              Ramifica se o contato tem um <strong>número de WhatsApp</strong> no cadastro. Número marcado como errado não conta. Só olha
              o cadastro, não confere se o número existe no WhatsApp. Use no “Sim” a mensagem no WhatsApp; no “senão”, o e-mail ou a
              ligação.
            </p>
          )}
        </div>
      )}
      {cond.type === "has_email" && (
        <p className="text-xs text-muted-foreground/70">
          Ramifica se o contato tem um <strong>e-mail</strong> no cadastro. E-mail que já voltou como inexistente não conta. É a mesma
          regra do passo Enviar e-mail. Use no “Sim” o envio de e-mail; no “senão”, outro canal.
        </p>
      )}
      {cond.type === "reply_class" && (
        <div className="space-y-1">
          <Label className="text-caption">A resposta foi</Label>
          <Select value={cond.classe} onValueChange={(v) => applyCond({ type: "reply_class", classe: v as "sem_interesse" | "interesse" | "outro" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sem_interesse">Sem interesse (“não quero”, “já tenho”…)</SelectItem>
              <SelectItem value="interesse">Tenho interesse (“quero saber”, “quanto custa”, “sim”…)</SelectItem>
              <SelectItem value="outro">Outra (não casou com nenhuma das duas)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground/70">
            Lê o que a pessoa respondeu depois do último envio e decide pelas palavras, na hora e sem custo (não usa IA). Use depois de
            “Respondeu”. Sem resposta, cai no “senão”. “Outra” é o que sobra: bom para mandar a um agente.
          </p>
        </div>
      )}
      {cond.type === "reply_text" && (
        <div className="space-y-1">
          <Label className="text-caption">Palavra (várias, separadas por vírgula)</Label>
          <Input value={cond.texto} onChange={(e) => applyCond({ ...cond, texto: e.target.value })} placeholder="já tenho, não preciso" />
          {cond.texto.trim() === "" && <p className="text-xs text-danger-500">Escreva a palavra para este ramo valer.</p>}
          <Select value={cond.modo} onValueChange={(v) => applyCond({ ...cond, modo: v as "contem" | "exato" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="contem">Aparece em qualquer parte da resposta</SelectItem>
              <SelectItem value="exato">A resposta inteira é a palavra</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground/70">
            Não importa maiúscula nem acento. Exemplo: “já tenho” casa com “Obrigado, Já tenho”. Em “inteira”, só casa se a mensagem for só a
            palavra (“Sim.” casa com “sim”).
          </p>
        </div>
      )}
      {cond.type === "channel_history" && (
        <div className="space-y-1">
          <Label className="text-caption">Canal</Label>
          <Select value={cond.canal} onValueChange={(v) => applyCond({ type: "channel_history", canal: v as "whatsapp" | "email" | "instagram" })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="whatsapp">WhatsApp (conversa real, antes da plataforma)</SelectItem>
              <SelectItem value="email">E-mail (histórico na plataforma)</SelectItem>
              <SelectItem value="instagram">Instagram (histórico na plataforma)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground/70">
            Ramifica se o contato já foi abordado nesse canal. WhatsApp checa a conversa real na Evolution
            (detecta contato já falado antes da plataforma).
          </p>
        </div>
      )}
      {cond.type === "responded" && (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-caption">Canal da resposta</Label>
            <Select
              value={cond.canal ?? "__any__"}
              onValueChange={(v) =>
                applyCond({
                  type: "responded",
                  janelaMin: cond.janelaMin,
                  canal: v === "__any__" ? undefined : (v as "whatsapp" | "email" | "instagram" | "linkedin"),
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">Qualquer canal</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="email">E-mail</SelectItem>
                <SelectItem value="instagram">Instagram</SelectItem>
                <SelectItem value="linkedin">LinkedIn</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground/70">
              Restringe a “respondeu?” a um canal específico (ex.: respondeu no WhatsApp, mas não no
              e-mail). “Qualquer canal” casa com qualquer resposta recebida.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-caption">Aguardar resposta por (min)</Label>
            <Input
              type="number"
              min={1}
              value={cond.janelaMin ?? 60}
              onChange={(e) =>
                onChange({
                  ...branch,
                  condition: { type: "responded", janelaMin: Number(e.target.value) || 1, canal: cond.canal },
                })
              }
            />
            <p className="text-xs text-muted-foreground/70">
              Sem janela, a condição é medida no instante em que o fluxo chega nela. Logo após um
              envio, isso é sempre “não respondeu”. Com janela, o motor re-checa até esse prazo antes
              de cair no “senão”.
            </p>
          </div>
        </div>
      )}
      {cond.type === "tag_present" && (
        <SeletorDeTag value={cond.tag} onChange={(t) => onChange({ ...branch, condition: { type: "tag_present", tag: t?.nome ?? "" } })} />
      )}
      {cond.type === "stage_is" && (
        <Select value={cond.stageId} onValueChange={(v) => onChange({ ...branch, condition: { type: "stage_is", stageId: v } })}>
          <SelectTrigger>
            <SelectValue placeholder="Etapa" />
          </SelectTrigger>
          <SelectContent>
            {funnels.flatMap((f) => f.stages.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {f.nome} · {s.nome}
              </SelectItem>
            )))}
          </SelectContent>
        </Select>
      )}
      <p className="text-xs text-muted-foreground/70">
        Destino: puxe a conexão da bolinha à direita deste ramo no mapa.
      </p>
    </div>
  );
}

/** Seletor de fluxo de destino para o passo "Mudar de fluxo". */
function SwitchFlowPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [flows, setFlows] = useState<{ id: string; nome: string }[]>([]);
  useEffect(() => {
    void listFlowsForSwitchAction().then(setFlows).catch(() => {});
  }, []);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue placeholder="Escolha o fluxo…" />
      </SelectTrigger>
      <SelectContent>
        {flows.map((f) => (
          <SelectItem key={f.id} value={f.id}>{f.nome}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * "Padrão da caixa que enviar" — o mesmo valor de `ASSINATURA_PADRAO_DA_CAIXA`
 * em packages/core/src/email/signatures.ts (componente cliente não importa
 * valor do core).
 */
const ASSINATURA_PADRAO_DA_CAIXA = "padrao-da-caixa";

/**
 * Seletor de assinatura para o passo de e-mail. A assinatura é POR CAIXA
 * (28/09): lista as de cada caixa com o nome dela; no envio vale a escolhida só
 * se for da caixa que enviar — senão sai a padrão dessa caixa.
 */
function EmailSignaturePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [sigs, setSigs] = useState<{ id: string; nome: string; caixa: string | null }[]>([]);
  useEffect(() => {
    void listAssinaturasParaFluxoAction()
      .then((l) => setSigs(l.map((s) => ({ id: s.id, nome: s.nome, caixa: s.caixa }))))
      .catch(() => {});
  }, []);
  return (
    <>
      <Select value={value || "__none__"} onValueChange={(v) => onChange(v === "__none__" ? "" : v)}>
        <SelectTrigger>
          <SelectValue placeholder="Nenhuma" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">Nenhuma</SelectItem>
          <SelectItem value={ASSINATURA_PADRAO_DA_CAIXA}>Padrão da caixa que enviar</SelectItem>
          {sigs.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.caixa ? `${s.nome} · ${s.caixa}` : s.nome}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground/70">
        Cada caixa tem as suas assinaturas (Integrações → Canais → E-mail). Se a escolhida for de outra caixa, sai a
        padrão da caixa que enviar.
      </p>
    </>
  );
}
