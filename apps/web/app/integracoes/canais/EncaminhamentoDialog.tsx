"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle2, Copy, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
// Do core, SÓ tipo: componente cliente não importa valor do `@crmagro/core`.
import type { EncaminhamentoDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { copiarTexto } from "@/lib/copiar";
import { formatWhen } from "@/lib/format";
import {
  desligarEncaminhamentoAction,
  garantirEncaminhamentoAction,
  gerarEncaminhamentoAction,
  obterEncaminhamentoAction,
} from "../email/encaminhamento-actions";
import {
  PASSOS_DO_ASSISTENTE_TOTAL,
  TITULOS_DOS_PASSOS,
  deveContinuarPerguntando,
  diasSemEmail,
  linkDeConfirmacaoExibivel,
  passoAposAtualizacao,
  passoInicialDoAssistente,
  urlDoEncaminhamentoDoGmail,
  type PassoDoAssistente,
} from "./encaminhamento";
import { useJanelinha } from "./use-janelinha";

/** De quanto em quanto tempo o diálogo aberto pergunta se o Google já confirmou. */
const INTERVALO_DO_POLLING_MS = 5000;

/**
 * "Receber e-mails sem senha": o assistente, passo a passo, do encaminhamento do Gmail para o endereço
 * da caixa. Quatro passos (adicionar no Gmail, confirmar, ligar, pronto), um por vez; o endereço já vem
 * gerado no primeiro (se a caixa ainda não tinha, é gerado ao abrir). O Gmail e a
 * confirmação do Google abrem numa janelinha, sem sair do CRM Agro, e o assistente avança sozinho quando
 * consegue saber que o passo terminou: o pedido do Google chegou, a janelinha foi fechada ou o primeiro
 * e-mail chegou. Quem abre e fecha é a linha da caixa (`open`/`onOpenChange`), que também abre sozinha
 * logo depois de conectar o Gmail sem senha.
 */
export function EncaminhamentoDialog({
  accountId,
  label,
  open,
  onOpenChange,
}: {
  accountId: string;
  label: string;
  open: boolean;
  onOpenChange: (aberto: boolean) => void;
}) {
  // undefined = carregando · null = a caixa ainda não tem endereço.
  const [dto, setDto] = useState<EncaminhamentoDTO | null | undefined>(undefined);
  const [passo, setPasso] = useState<PassoDoAssistente>(1);
  const [ocupado, setOcupado] = useState<"gerar" | "desligar" | null>(null);
  // Quando o diálogo abriu (ou o endereço foi gerado): o polling para 10 minutos depois.
  const desde = useRef(0);
  // As duas funções são estáveis (useCallback): o objeto que o hook devolve muda a cada renderização e NÃO entra nas dependências.
  const { abrir: abrirJanelinha, fechar: fecharJanelinha } = useJanelinha();
  // O endereço é gerado sozinho UMA vez por abertura, quando a caixa ainda não tem (nunca troca um que já existe).
  const geradoNestaAbertura = useRef(false);
  const estado = dto?.estado ?? null;
  // O rótulo da caixa do Gmail é o próprio e-mail; em outra caixa, não dá para afirmar a conta.
  const conta = label.includes("@") ? label : null;

  const carregar = useCallback(
    async (silencioso: boolean, primeira = false) => {
      const r = await obterEncaminhamentoAction(accountId);
      if (r.error) {
        if (!silencioso) toast.error(r.error);
        return;
      }
      let novo = r.dto ?? null;
      // Caixa sem endereço, na primeira leitura: garante um na hora, para a pessoa já ver o endereço no primeiro passo.
      // "Garantir" só cria se não houver (duas telas abertas ao mesmo tempo terminam com o mesmo endereço).
      if (primeira && novo === null && !geradoNestaAbertura.current) {
        geradoNestaAbertura.current = true;
        const g = await garantirEncaminhamentoAction(accountId);
        if (g.error) toast.error(g.error);
        else novo = g.dto ?? null;
      }
      setDto(novo);
      // Na primeira leitura, abre no passo que o servidor já sabe; depois, só acompanha (nunca volta).
      setPasso((p) => (primeira ? passoInicialDoAssistente(novo) : passoAposAtualizacao(p, novo)));
    },
    [accountId],
  );

  // Ao abrir: marca a hora e busca o endereço. Ao fechar, fecha também a janelinha do Google.
  useEffect(() => {
    if (!open) {
      fecharJanelinha();
      return;
    }
    desde.current = Date.now();
    geradoNestaAbertura.current = false;
    setDto(undefined);
    void carregar(false, true);
  }, [open, carregar, fecharJanelinha]);

  // Qualquer troca de passo (clique, janelinha fechada ou aviso do servidor) fecha a janelinha que sobrou.
  useEffect(() => {
    fecharJanelinha();
  }, [passo, fecharJanelinha]);

  // Polling só com o diálogo aberto e só enquanto falta o primeiro e-mail; o `clearInterval`
  // roda ao fechar, ao mudar o estado e ao passar de 10 minutos.
  useEffect(() => {
    if (!open || !estado || !deveContinuarPerguntando(estado, desde.current, Date.now())) return;
    const timer = setInterval(() => {
      if (!deveContinuarPerguntando(estado, desde.current, Date.now())) {
        clearInterval(timer);
        return;
      }
      void carregar(true);
    }, INTERVALO_DO_POLLING_MS);
    return () => clearInterval(timer);
  }, [open, estado, carregar]);

  const irPara = (p: number) => setPasso(Math.min(PASSOS_DO_ASSISTENTE_TOTAL, Math.max(1, p)) as PassoDoAssistente);

  async function gerar(pedirConfirmacao: boolean) {
    if (
      pedirConfirmacao &&
      !confirm("O endereço atual para de funcionar. Você vai precisar trocar no Gmail. Continuar?")
    ) {
      return;
    }
    setOcupado("gerar");
    const r = await gerarEncaminhamentoAction(accountId);
    setOcupado(null);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    desde.current = Date.now();
    setDto(r.dto ?? null);
    // Endereço novo: os passos de adicionar, confirmar e ligar valem de novo.
    irPara(1);
  }

  async function desligar() {
    if (!confirm("Desligar o recebimento sem senha desta caixa?")) return;
    setOcupado("desligar");
    const r = await desligarEncaminhamentoAction(accountId);
    setOcupado(null);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    toast.success("Recebimento sem senha desligado");
    setDto(null);
    irPara(1);
  }

  async function copiar(endereco: string) {
    if (await copiarTexto(endereco)) toast.success("Endereço copiado");
    else toast.error("Não deu para copiar. Selecione o endereço e copie à mão.");
  }

  const endereco = dto?.endereco ?? null;
  const link = linkDeConfirmacaoExibivel(dto?.linkConfirmacao ?? null);

  // O botão principal de cada passo, o texto do "próximo" e se ele está liberado.
  const proximo: { texto: string; ativo: boolean; destaque: boolean } | null =
    passo === 1
      ? { texto: "Já adicionei", ativo: endereco !== null, destaque: endereco !== null }
      : passo === 2
        ? { texto: "Já confirmei", ativo: true, destaque: !link }
        : passo === 3
          ? { texto: "Já salvei", ativo: true, destaque: true }
          : null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!ocupado) onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Receber e-mails sem senha</DialogTitle>
          <DialogDescription>
            O Gmail manda uma cópia de cada e-mail que chega para um endereço só seu. É assim que o CRM Agro recebe as respostas dos
            seus contatos, sem senha de app.
          </DialogDescription>
        </DialogHeader>

        {dto === undefined ? (
          <div className="flex items-center gap-2 py-6 text-small text-ink-2" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : (
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="num text-small text-ink-2">
                Passo {passo} de {PASSOS_DO_ASSISTENTE_TOTAL} · {TITULOS_DOS_PASSOS[passo - 1]}
              </p>
              <Progress value={(passo / PASSOS_DO_ASSISTENTE_TOTAL) * 100} aria-label={`Passo ${passo} de ${PASSOS_DO_ASSISTENTE_TOTAL}`} />
            </div>

            {passo === 1 ? (
              <Etapa titulo="Adicione o endereço no Gmail">
                <p className="text-small text-ink-2">
                  {conta ? `Entre na conta ${conta}. ` : ""}Copie o endereço abaixo, abra o encaminhamento do Gmail, clique em
                  &quot;Adicionar um endereço de encaminhamento&quot;, cole o endereço e siga &quot;Próxima&quot;, &quot;Continuar&quot; e
                  &quot;OK&quot;.
                </p>
                {endereco ? (
                  <>
                    <EnderecoCopiavel endereco={endereco} onCopiar={(e) => void copiar(e)} />
                    <Button variant="outline" onClick={() => abrirJanelinha(urlDoEncaminhamentoDoGmail(conta))}>
                      Abrir o Gmail <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                    <p className="text-caption text-ink-3">
                      Quando o Google receber o pedido, o próximo passo abre sozinho. Se não abrir em um minuto, clique em &quot;Já
                      adicionei&quot;.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-small text-ink-2">Não deu para gerar o endereço desta caixa agora. Tente de novo.</p>
                    <Button onClick={() => void gerar(false)} disabled={ocupado !== null}>
                      {ocupado === "gerar" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                      Gerar meu endereço
                    </Button>
                  </>
                )}
              </Etapa>
            ) : null}

            {passo === 2 ? (
              <Etapa titulo="Confirme o pedido do Google">
                {link ? (
                  <>
                    <p className="text-small text-ink-2">
                      O Google mandou o pedido. Clique abaixo e, na janelinha, em &quot;Confirmar&quot;. Quando fechar a janelinha, o
                      próximo passo abre sozinho.
                    </p>
                    <Button onClick={() => abrirJanelinha(link, () => irPara(3))}>
                      Confirmar encaminhamento <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <p className="text-small text-ink-2">
                    O Google manda o pedido em até 2 minutos, e o botão para confirmar aparece aqui. Se ele avisar no seu celular,
                    confirme por lá e clique em &quot;Já confirmei&quot;.
                  </p>
                )}
              </Etapa>
            ) : null}

            {passo === 3 ? (
              <Etapa titulo="Ligue o encaminhamento">
                <p className="text-small text-ink-2">
                  No Gmail, na mesma tela, marque &quot;Encaminhar uma cópia do e-mail recebido para&quot; e escolha o endereço. Mantenha
                  a cópia na Caixa de entrada e clique em &quot;Salvar alterações&quot;, no fim da página.
                </p>
                <Button variant="outline" onClick={() => abrirJanelinha(urlDoEncaminhamentoDoGmail(conta), () => irPara(4))}>
                  Abrir o Gmail <ExternalLink className="h-3.5 w-3.5" />
                </Button>
                <p className="text-caption text-ink-3">Quando fechar a janelinha, o último passo abre sozinho.</p>
              </Etapa>
            ) : null}

            {passo === 4 ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-1 h-6 w-6 shrink-0 text-success-600" aria-hidden />
                  <div className="space-y-1">
                    <h3 className="font-serif text-h2">Configuração finalizada</h3>
                    <p className="text-small text-ink-2">
                      Falta só um teste: crie um contato com o seu e-mail pessoal e mande um e-mail dele para {conta ?? "esta caixa"}.
                    </p>
                  </div>
                </div>
                <ul className="list-disc space-y-1 pl-9 text-small text-ink-2 marker:text-ink-3">
                  <li>A bolinha fica verde quando o primeiro e-mail encaminhado chega.</li>
                  <li>A conversa aparece em Conversas, E-mail, só quando quem mandou é um contato cadastrado. Os outros são descartados na hora.</li>
                </ul>
                <Button asChild variant="outline">
                  <Link href="/contatos">Abrir Contatos</Link>
                </Button>
              </div>
            ) : null}

            {dto ? <EstadoDoEncaminhamento dto={dto} /> : null}

            <div className="flex items-center justify-between gap-2 border-t border-line pt-4">
              {passo > 1 ? (
                <Button variant="ghost" onClick={() => irPara(passo - 1)} disabled={ocupado !== null}>
                  <ArrowLeft className="h-4 w-4" /> Voltar
                </Button>
              ) : (
                <span />
              )}
              {proximo ? (
                <Button
                  variant={proximo.destaque ? "default" : "outline"}
                  onClick={() => irPara(passo + 1)}
                  disabled={!proximo.ativo || ocupado !== null}
                >
                  {proximo.texto} <ArrowRight className="h-4 w-4" />
                </Button>
              ) : (
                <Button onClick={() => onOpenChange(false)}>Concluir</Button>
              )}
            </div>

            <details className="border-t border-line pt-3">
              <summary className="cursor-pointer list-none text-small text-ink-2 hover:text-foreground">Mais opções e avisos</summary>
              <div className="mt-3 space-y-3">
                <div className="space-y-1 text-caption text-ink-3">
                  <p>Só entram os e-mails que chegarem a partir de agora (sem spam e sem os antigos).</p>
                  <p>
                    No Google Workspace, cada pessoa só pode ter um endereço de encaminhamento. Se você já encaminha para outro lugar,
                    use um filtro (Pesquisar, Criar filtro, Encaminhar para). Se a aba não aparece, o administrador da sua empresa
                    desligou o encaminhamento.
                  </p>
                  <p>Por uma semana, o Gmail mostra um aviso de que está encaminhando. É normal.</p>
                  <p>O CRM Agro guarda só os e-mails de contatos cadastrados. Os outros são descartados na hora, sem guardar o conteúdo.</p>
                </div>
                {dto ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {endereco ? (
                      <Button variant="outline" size="sm" onClick={() => void gerar(true)} disabled={ocupado !== null}>
                        {ocupado === "gerar" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                        Gerar novo endereço
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="sm" onClick={() => void desligar()} disabled={ocupado !== null}>
                      {ocupado === "desligar" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                      Desligar o recebimento
                    </Button>
                  </div>
                ) : null}
              </div>
            </details>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** O endereço `r+…@…` numa caixa com o botão de copiar. */
function EnderecoCopiavel({ endereco, onCopiar }: { endereco: string; onCopiar: (endereco: string) => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line-strong px-3 py-2">
      <code className="min-w-0 flex-1 break-all font-mono text-small text-foreground">{endereco}</code>
      <Button variant="outline" size="sm" onClick={() => onCopiar(endereco)}>
        <Copy className="mr-1.5 h-3.5 w-3.5" /> Copiar
      </Button>
    </div>
  );
}

/** Um passo do assistente: o título e o que a pessoa faz nele. */
function Etapa({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="font-serif text-h2">{titulo}</h3>
      {children}
    </section>
  );
}

/** Em que pé está o encaminhamento (a linha de baixo de todo passo). */
function EstadoDoEncaminhamento({ dto }: { dto: EncaminhamentoDTO }) {
  const link = linkDeConfirmacaoExibivel(dto.linkConfirmacao);
  // Sem um link do Google que valha, "confirmar" não tem o que mostrar: segue como "aguardando".
  const estado = dto.estado === "confirmar" && !link ? "aguardando_confirmacao" : dto.estado;
  const dias = diasSemEmail(dto.ultimoRecebidoEm, Date.now());

  const linha: { tone: StatusTone; texto: string } =
    estado === "funcionando"
      ? {
          tone: "ok",
          texto: dto.ultimoRecebidoEm ? `Funcionando. Último e-mail recebido ${formatWhen(dto.ultimoRecebidoEm)}.` : "Funcionando.",
        }
      : estado === "sem_email_recente"
        ? {
            tone: "attention",
            texto: `${dias !== null ? `Nenhum e-mail chegou há ${dias} ${dias === 1 ? "dia" : "dias"}` : "Nenhum e-mail chegou há mais de 3 dias"}. Confira no Gmail se o encaminhamento continua ligado.`,
          }
        : estado === "confirmar"
          ? { tone: "attention", texto: "O Google mandou o pedido. Falta chegar o primeiro e-mail encaminhado." }
          : { tone: "info", texto: "Aguardando o e-mail de confirmação do Google…" };

  return (
    <div role="status" aria-live="polite">
      {/* O StatusDot é nowrap por padrão; aqui o texto pode ser longo e precisa quebrar dentro do pop-up. */}
      <StatusDot tone={linha.tone} className="items-start whitespace-normal [&>span:first-child]:mt-[7px]">
        {linha.texto}
      </StatusDot>
    </div>
  );
}
