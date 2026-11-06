"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { tagsDoTimeAction } from "@/app/contatos/actions";
import { TagPill } from "@/components/ui/tag-pill";
import { chaveDeTag, incluirTags, opcoesDeTags, separarTagsDigitadas, type OpcaoDeTag, type TagDoTime } from "@/lib/tags-input";
import { cn } from "@/lib/utils";

/**
 * Campo "Tags" do contato: as tags escolhidas viram pílulas com "x" e, ao focar ou digitar, aparecem as tags que o
 * time já cadastrou (sem acento e sem diferença de maiúscula), com quantos contatos têm cada uma. Texto que não
 * existe vira tag nova ("Criar tag ..."). Serve ao cadastro, à ficha e a qualquer formulário de contato. As regras
 * (o que a lista mostra, como o texto vira tag) moram em `lib/tags-input.ts`, testadas sem DOM.
 *
 * - Enter, vírgula ou sair do campo confirmam o texto; Backspace no campo vazio tira a última; setas escolhem.
 *   O Enter escolhe a tag de nome IGUAL ao texto ou, não havendo, "Criar tag": uma sugestão só entra por seta ou clique,
 *   porque tag parecida escolhida sem querer pode disparar o fluxo dela.
 * - Sem a lista do time (erro de rede, sessão vencida) vira campo livre: nunca trava o cadastro.
 * - A lista de sugestões fica NO FLUXO da tela (empurra o conteúdo), não flutuando: dentro de pop-up com rolagem
 *   uma lista flutuante é cortada pela borda (mesma decisão de `cidade-estado.tsx`).
 * - Esc com a lista aberta fecha só a lista, não o diálogo em volta (o que foi digitado no formulário não se perde).
 */

type Props = {
  value: string[];
  onChange: (tags: string[]) => void;
  /** Liga o rótulo ao campo. */
  id?: string;
  desativado?: boolean;
  placeholder?: string;
};

export function TagsInput({ value, onChange, id, desativado, placeholder = "Buscar ou criar tag" }: Props) {
  const gerado = useId();
  const base = id ?? gerado;
  const entradaRef = useRef<HTMLInputElement>(null);
  const [catalogo, setCatalogo] = useState<TagDoTime[]>([]);
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);
  const [destaque, setDestaque] = useState(-1);

  useEffect(() => {
    let vivo = true;
    tagsDoTimeAction()
      .then((t) => vivo && setCatalogo(t))
      .catch(() => {}); // sem a lista, o campo segue livre
    return () => {
      vivo = false;
    };
  }, []);

  const { opcoes, restantes } = useMemo(() => opcoesDeTags({ catalogo, value, texto }), [catalogo, value, texto]);
  const mostrarLista = aberto && !desativado && opcoes.length > 0;
  const listaId = `${base}-lista`;
  const opcaoId = (i: number) => `${base}-opcao-${i}`;

  // A opção destacada pelas setas acompanha a rolagem da lista.
  useEffect(() => {
    if (mostrarLista && destaque >= 0) document.getElementById(`${base}-opcao-${destaque}`)?.scrollIntoView({ block: "nearest" });
  }, [mostrarLista, destaque, base]);

  // Esc com a lista aberta fecha SÓ a lista. O diálogo (Radix) escuta o Esc em `document`, na captura; `window`
  // vem antes, então o evento é segurado aqui antes de o diálogo vê-lo.
  const listaAbertaRef = useRef(false);
  useEffect(() => {
    listaAbertaRef.current = mostrarLista;
  }, [mostrarLista]);
  useEffect(() => {
    function aoApertarEsc(e: globalThis.KeyboardEvent) {
      if (e.key !== "Escape" || !listaAbertaRef.current || document.activeElement !== entradaRef.current) return;
      e.stopPropagation();
      setAberto(false);
    }
    window.addEventListener("keydown", aoApertarEsc, true);
    return () => window.removeEventListener("keydown", aoApertarEsc, true);
  }, []);

  /** Põe as tags na ordem, de uma vez (várias de um colar de texto), sem repetir. */
  function incluir(nomes: string[]) {
    const proximo = incluirTags(value, nomes, catalogo);
    if (proximo !== value) onChange([...proximo]);
  }

  function escolher(o: OpcaoDeTag) {
    incluir([o.tipo === "tag" ? o.tag.nome : o.nome]);
    setTexto("");
    setDestaque(-1);
    setAberto(true);
    entradaRef.current?.focus();
  }

  function confirmarTexto() {
    if (!texto.trim()) return;
    incluir([texto]);
    setTexto("");
    setDestaque(-1);
  }

  function aoDigitar(v: string) {
    // Vírgula (digitada ou num texto colado) fecha a tag; o que sobra continua no campo.
    const separado = separarTagsDigitadas(v);
    if (separado) incluir(separado.prontas);
    const restante = separado ? separado.resto : v;
    setTexto(restante);
    setAberto(true);
    // O Enter já sabe o que vai escolher: a tag de nome igual ao texto ou "Criar tag" (nunca uma sugestão parecida).
    const aposInclusao = separado ? incluirTags(value, separado.prontas, catalogo) : value;
    setDestaque(opcoesDeTags({ catalogo, value: aposInclusao, texto: restante }).destaquePadrao);
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
      const o = mostrarLista ? opcoes[destaque] : undefined;
      if (o) {
        e.preventDefault();
        escolher(o);
      } else if (texto.trim()) {
        e.preventDefault();
        confirmarTexto();
      }
      // Campo vazio: o Enter segue e envia o formulário.
    } else if (e.key === "Backspace" && !e.repeat && texto === "" && value.length > 0) {
      // Sem `repeat`: segurar a tecla não pode esvaziar as pílulas uma a uma.
      onChange(value.slice(0, -1));
    }
  }

  function aoSair() {
    // O que foi digitado e não confirmado vira tag: senão o "Salvar" logo em seguida perderia o texto em silêncio.
    confirmarTexto();
    setTimeout(() => setAberto(false), 120);
  }

  return (
    <div>
      <div
        className={cn(
          "flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line-strong bg-background px-2 py-1 transition-colors focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-ring/20",
          desativado && "cursor-not-allowed opacity-50",
        )}
        onClick={() => entradaRef.current?.focus()}
      >
        {value.map((nome) => (
          <TagPill
            key={nome}
            nome={nome}
            cor={catalogo.find((t) => chaveDeTag(t.nome) === chaveDeTag(nome))?.cor}
            onRemove={desativado ? undefined : () => onChange(value.filter((v) => v !== nome))}
          />
        ))}
        <input
          ref={entradaRef}
          id={base}
          value={texto}
          onChange={(e) => aoDigitar(e.target.value)}
          onFocus={() => setAberto(true)}
          onBlur={aoSair}
          onKeyDown={aoTeclar}
          placeholder={value.length === 0 ? placeholder : undefined}
          disabled={desativado}
          autoComplete="off"
          role="combobox"
          aria-expanded={mostrarLista}
          aria-controls={listaId}
          aria-autocomplete="list"
          aria-activedescendant={mostrarLista && destaque >= 0 ? opcaoId(destaque) : undefined}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-body text-foreground outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
        />
      </div>
      {mostrarLista && (
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
                id={opcaoId(i)}
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

/**
 * Versão para formulários de `action` (FormData): guarda a lista internamente e entrega no campo escondido `name`
 * (padrão `tags`) como lista em JSON, que o servidor lê com `tagsDoCampo`. Manda também `<name>Iniciais`: a lista
 * que a pessoa via ao abrir. O servidor grava só a diferença entre as duas, então salvar sem mexer nas tags não
 * toca em nada e tag que entrou por outro caminho nesse meio-tempo não é apagada. Lista vazia ainda manda o campo
 * (`[]`), o que diz "tirei todas"; formulário SEM este campo não mexe nas tags.
 */
export function TagsInputForm({
  inicial = [],
  name = "tags",
  id,
  desativado,
}: {
  inicial?: string[];
  name?: string;
  id?: string;
  desativado?: boolean;
}) {
  const [aoAbrir] = useState(inicial);
  const [tags, setTags] = useState<string[]>(inicial);
  return (
    <>
      <input type="hidden" name={name} value={JSON.stringify(tags)} />
      <input type="hidden" name={`${name}Iniciais`} value={JSON.stringify(aoAbrir)} />
      <TagsInput value={tags} onChange={setTags} id={id} desativado={desativado} />
    </>
  );
}
