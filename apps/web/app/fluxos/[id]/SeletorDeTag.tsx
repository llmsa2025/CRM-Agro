"use client";

import { TagSelect, type AcoesDoSeletorDeTag, type TagEscolhida } from "@/components/tag-select";
import { garantirTagDoCatalogoAction, tagsDoCatalogoAction } from "../actions";

/** Constante do módulo: o seletor só recarrega a lista quando as actions mudam, nunca a cada render. */
const ACOES: AcoesDoSeletorDeTag = { listar: tagsDoCatalogoAction, criar: garantirTagDoCatalogoAction };

/**
 * O `TagSelect` com as actions da tela Fluxos. O gatilho "Tag adicionada", o passo "Adicionar tag" e a condição "Tem tag"
 * escolhem a tag por aqui: uma que o time já cadastrou ou uma nova, do mesmo catálogo de Contatos.
 */
export function SeletorDeTag(props: { value: string; onChange: (tag: TagEscolhida | null) => void; id?: string }) {
  return <TagSelect {...props} acoes={ACOES} />;
}
