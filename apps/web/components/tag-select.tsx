"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { TagPill } from "@/components/ui/tag-pill";
import { acharNoCatalogo, comTagNoCatalogo, opcoesDeTags, type OpcaoDeTag, type TagDoTime } from "@/lib/tags-input";
import { cn } from "@/lib/utils";

/**
 * Escolher UMA tag: ou uma que o time já cadastrou, ou uma nova. É o par do `TagsInput` (várias tags, no formulário do
 * contato) e lê o MESMO catálogo, então a tag criada aqui já aparece em Contatos, Campanhas, Mapa e em todos os outros
 * seletores. Serve ao gatilho "Tag adicionada", ao passo "Adicionar tag" e à condição "Tem tag" do editor de fluxos.
 *
 * - Ao focar, a lista mostra as tags do time (as mais usadas primeiro); digitar filtra (sem acento e sem diferença de
 *   maiúscula) e, se o texto não existe, oferece "Criar tag". Escolher fecha a lista; o "x" da pílula tira a tag.
 * - "Criar tag" grava a tag no catálogo na hora, não só quando a tela salva: é o que faz a tag nova aparecer nos outros
 *   lugares. Pedir para criar um nome que já existe devolve a tag que existe, nunca uma repetida.
 * - O Enter escolhe a tag de nome IGUAL ao texto ou "Criar tag"; uma sugestão só parecida entra por seta ou clique,
 *   porque tag escolhida sem querer pode disparar o fluxo dela. Sair do campo com texto não escolhido descarta o texto
 *   (nunca cria tag por acidente).
 * - `onChange` entrega id e nome: quem usa guarda o que precisa (o passo do fluxo guarda o nome, o gatilho guarda o id).
 * - A lista fica NO FLUXO da tela (empurra o conteúdo), como no `TagsInput`: no painel lateral uma lista flutuante é cortada.
 * - As regras da lista e do nome moram em `lib/tags-input.ts`, testadas sem DOM.
 */

/** O que o seletor pede ao servidor. Cada tela passa as actions da PRÓPRIA tela, que conferem o acesso a ela. */
export type AcoesDoSeletorDeTag = {
  listar: () => Promise<TagDoTime[]>;
  /** Cria a tag no catálogo, ou devolve a que já tem esse nome. */
  criar: (nome: string) => Promise<{ error?: string; tag?: { id: string; nome: string } }>;
};

export type TagEscolhida = { id: string; nome: string };

type Props = {
  /** Nome da tag escolhida; vazio = nenhuma. */
  value: string;
  onChange: (tag: TagEscolhida | null) => void;
  acoes: AcoesDoSeletorDeTag;
  /** Liga o rótulo ao campo. */
  id?: string;
  desativado?: boolean;
  placeholder?: string;
};

export function TagSelect({ value, onChange, acoes, id, desativado, placeholder = "Buscar ou criar tag" }: Props) {
  const { listar, criar } = acoes;
  const gerado = useId();
  const base = id ?? gerado;
  const entradaRef = useRef<HTMLInputElement>(null);
  // null = carregando. Sem a lista (erro de rede, sessão vencida) vira [] com `semLista`: ainda dá para criar.
  const [catalogo, setCatalogo] = useState<readonly TagDoTime[] | null>(null);
  const [semLista, setSemLista] = useState(false);
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);
  const [destaque, setDestaque] = useState(-1);
  const [criando, setCriando] = useState(false);
  const focarAoLimpar = useRef(false);

  useEffect(() => {
    let vivo = true;
    listar()
      .then((t) => vivo && setCatalogo(t))
      .catch(() => {
        if (!vivo) return;
        setCatalogo([]);
        setSemLista(true);
      });
    return () => {
      vivo = false;
    };
  }, [listar]);

  // Depois do "x" a pílula some e o campo volta: o foco vai para ele.
  useEffect(() => {
    if (!value && focarAoLimpar.current) {
      focarAoLimpar.current = false;
      entradaRef.current?.focus();
    }
  }, [value]);

  const naLista = value ? acharNoCatalogo(catalogo ?? [], value) : undefined;
  // Fluxo antigo, em que o nome foi digitado à mão: o nome existe no passo, mas ainda não no catálogo do time.
  const foraDoCatalogo = Boolean(value) && catalogo !== null && !semLista && !naLista;
  const { opcoes, restantes } = useMemo(
    () => (catalogo ? opcoesDeTags({ catalogo, value: [], texto }) : { opcoes: [] as OpcaoDeTag[], restantes: 0 }),
    [catalogo, texto],
  );
  const mostrarLista = aberto && !desativado && !value;
  const temOpcoes = mostrarLista && !criando && opcoes.length > 0;
  const listaId = `${base}-lista`;

  // A opção destacada pelas setas acompanha a rolagem da lista.
  useEffect(() => {
    if (temOpcoes && destaque >= 0) document.getElementById(`${base}-opcao-${destaque}`)?.scrollIntoView({ block: "nearest" });
  }, [temOpcoes, destaque, base]);

  function aplicar(tag: TagEscolhida) {
    setTexto("");
    setDestaque(-1);
    setAberto(false);
    onChange(tag);
  }

  /**
   * Grava a tag no catálogo (ou acha a que já tem esse nome) e escolhe ela. A resposta volta depois de um tempo e o
   * `onChange` usado é o do instante do clique: se a pessoa já foi para outro passo do fluxo, a tag vai para o passo
   * em que ela clicou, não para o que está aberto agora.
   */
  async function criarEEscolher(nome: string) {
    if (criando) return;
    setCriando(true);
    try {
      const r = await criar(nome);
      if (!r.tag) {
        toast.error("Não foi possível criar a tag", { description: r.error });
        return;
      }
      const tag = r.tag;
      setCatalogo((atual) => comTagNoCatalogo(atual ?? [], tag));
      aplicar(tag);
    } catch {
      toast.error("Não foi possível criar a tag", { description: "Tente de novo em instantes." });
    } finally {
      setCriando(false);
    }
  }

  function escolher(o: OpcaoDeTag) {
    if (o.tipo === "tag") aplicar({ id: o.tag.id, nome: o.tag.nome });
    else void criarEEscolher(o.nome);
  }

  function limpar() {
    focarAoLimpar.current = true;
    onChange(null);
  }

  function aoSair() {
    // Texto digitado e não escolhido é descartado: nada é criado por acidente, e o texto não passa para o próximo
    // passo do fluxo quando o painel reaproveita este campo. Tudo junto e depois de um instante, para um toque numa
    // opção (que pode tirar o foco do campo em alguns celulares) ainda valer, e a lista não piscar sem filtro.
    setTimeout(() => {
      if (document.activeElement === entradaRef.current) return; // a pessoa voltou para o campo (clique na borda dele)
      setTexto("");
      setDestaque(-1);
      setAberto(false);
    }, 120);
  }

  function aoDigitar(v: string) {
    setTexto(v);
    setAberto(true);
    // O Enter já sabe o que vai escolher: a tag de nome igual ao texto ou "Criar tag" (nunca uma sugestão parecida).
    setDestaque(catalogo ? opcoesDeTags({ catalogo, value: [], texto: v }).destaquePadrao : -1);
  }

  function aoTeclar(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      if (opcoes.length === 0) return;
      e.preventDefault();
      setAberto(true);
      setDestaque((d) => Math.min(d + 1, opcoes.length - 1));
    } else if (e.key === "ArrowUp") {
      if (opcoes.length === 0) return;
      e.preventDefault();
      setDestaque((d) => Math.max(d - 1, 0));
    } else if (e.key === "Enter") {
      const o = temOpcoes ? opcoes[destaque] : undefined;
      if (o) {
        e.preventDefault();
        escolher(o);
      }
    } else if (e.key === "Escape" && mostrarLista) {
      e.stopPropagation();
      setAberto(false);
    }
  }

  // O que a lista diz quando não há opção para mostrar.
  const aviso = !mostrarLista
    ? null
    : catalogo === null
      ? "Carregando tags…"
      : criando
        ? "Criando a tag…"
        : opcoes.length === 0
          ? semLista
            ? "Não foi possível carregar as tags do time. Digite um nome para criar."
            : "Nenhuma tag criada ainda. Digite um nome para criar."
          : null;

  return (
    <div>
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-md border border-line-strong bg-background px-2 py-1 transition-colors focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-ring/20",
          !value && "cursor-text",
          desativado && "cursor-not-allowed opacity-50",
        )}
        onClick={() => entradaRef.current?.focus()}
      >
        {value ? (
          <TagPill nome={naLista?.nome ?? value} cor={naLista?.cor} onRemove={desativado ? undefined : limpar} />
        ) : (
          <input
            ref={entradaRef}
            id={base}
            value={texto}
            onChange={(e) => aoDigitar(e.target.value)}
            onFocus={() => setAberto(true)}
            onBlur={aoSair}
            onKeyDown={aoTeclar}
            placeholder={placeholder}
            disabled={desativado || criando}
            autoComplete="off"
            role="combobox"
            aria-expanded={temOpcoes}
            aria-controls={listaId}
            aria-autocomplete="list"
            aria-activedescendant={temOpcoes && destaque >= 0 ? `${base}-opcao-${destaque}` : undefined}
            className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-body text-foreground outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
          />
        )}
      </div>

      {foraDoCatalogo && !criando && (
        <p className="mt-1 text-caption text-ink-3">
          Esta tag ainda não está no catálogo do time.{" "}
          <button
            type="button"
            onClick={() => void criarEEscolher(value)}
            className="font-medium text-foreground underline underline-offset-2 hover:text-brand-500"
          >
            Criar agora
          </button>
        </p>
      )}

      {aviso && (
        <p className="mt-1 flex items-center gap-1 px-1 text-caption text-ink-3" role="status">
          {criando && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {aviso}
        </p>
      )}

      {temOpcoes && (
        <ul
          id={listaId}
          role="listbox"
          aria-label="Tags"
          // Clicar na lista (inclusive na barra de rolagem) não tira o foco do campo.
          onMouseDown={(e) => e.preventDefault()}
          className="mt-1 max-h-48 overflow-y-auto rounded-md border bg-popover p-1 shadow-sm"
        >
          {opcoes.map((o, i) => (
            <li key={o.tipo === "tag" ? o.tag.id : "criar"} role="presentation">
              {/* A opção é o próprio botão (sem botão dentro de option). Fora da ordem do Tab: o foco fica no campo. */}
              <button
                type="button"
                role="option"
                id={`${base}-opcao-${i}`}
                aria-selected={i === destaque}
                tabIndex={-1}
                onClick={() => escolher(o)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-body hover:bg-muted",
                  i === destaque && "bg-muted",
                )}
              >
                {o.tipo === "tag" ? (
                  <>
                    <TagPill nome={o.tag.nome} cor={o.tag.cor} />
                    <span className="num ml-auto text-caption text-ink-3">{o.tag.count}</span>
                  </>
                ) : (
                  <span className="truncate">
                    Criar tag <span className="font-medium">&ldquo;{o.nome}&rdquo;</span>
                  </span>
                )}
              </button>
            </li>
          ))}
          {restantes > 0 && (
            <li role="presentation" className="px-2 py-1 text-caption text-ink-3">
              Mais {restantes} tags: continue digitando para filtrar.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
