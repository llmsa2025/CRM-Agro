"use client";

import { toast } from "sonner";
import { Hourglass } from "lucide-react";
import type { ResultadoDaVerificacaoAgro } from "@crmagro/core";
import { TagPill } from "@/components/ui/tag-pill";
import { verificarAgroAction } from "./actions";

/**
 * Verificador do agro na interface: selos dos tipos e a verificação em lote (botão "Verificar agro" da barra de seleção).
 * Os rótulos ficam aqui (e não vêm de `@crmagro/core`) porque componente de cliente não importa valor do core.
 */

export const AGRO_ORDEM = ["produtor", "fazenda", "armazem", "algodoeira", "pecuaria", "transportadora"] as const;
export const AGRO_ROTULO: Record<string, string> = {
  produtor: "Produtor",
  fazenda: "Fazenda",
  armazem: "Armazém",
  algodoeira: "Algodoeira",
  pecuaria: "Pecuária",
  transportadora: "Transportadora",
};

export type EstadoDaFotoAgro = "na_fila" | "lida" | "sem_foto" | "indisponivel";

export function AgroPills({ tipos }: { tipos: readonly string[] }) {
  return (
    <>
      {AGRO_ORDEM.filter((t) => tipos.includes(t)).map((t) => (
        <TagPill key={t} nome={AGRO_ROTULO[t] ?? t} cor="brand" />
      ))}
    </>
  );
}

/** A foto espera o Claude ler (pelo MCP crmagro-agro). */
export function FotoNaFila({ comTexto = false }: { comTexto?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-caption text-ink-3" title="A foto do WhatsApp espera a leitura do Claude">
      <Hourglass className="h-3 w-3" aria-hidden />
      {comTexto ? "Foto na fila" : <span className="sr-only">Foto na fila</span>}
    </span>
  );
}

/** O que a foto fez, em frase curta (vazio quando não há o que dizer). */
export function frasesDaFoto(foto: EstadoDaFotoAgro | null): string | undefined {
  switch (foto) {
    case "na_fila":
      return "A foto espera a leitura do Claude.";
    case "sem_foto":
      return "O contato não tem foto de perfil no WhatsApp.";
    case "indisponivel":
      return "Não deu para olhar a foto: sem WhatsApp conectado ou sem número.";
    default:
      return undefined;
  }
}

function nomesDosTipos(tipos: readonly string[]): string {
  return AGRO_ORDEM.filter((t) => tipos.includes(t))
    .map((t) => AGRO_ROTULO[t])
    .join(", ");
}

/**
 * Verifica UM contato e avisa o resultado. Devolve true quando a verificação rodou (mesmo sem achar nada),
 * para a tela atualizar. Contato ajustado à mão não é alterado: o aviso oferece verificar mesmo assim.
 */
export async function verificarUm(contactId: string, opts: { refazerFoto?: boolean; forcar?: boolean } = {}, aoMudar?: () => void): Promise<boolean> {
  const { resultado, error } = await verificarAgroAction(contactId, opts);
  if (error || !resultado) {
    toast.error("Não deu para verificar", { description: error });
    return false;
  }
  if (resultado.ajusteManualMantido) {
    toast.message("Este contato foi ajustado à mão", {
      description: "A verificação automática não mudou nada.",
      action: {
        label: "Verificar mesmo assim",
        onClick: () => void verificarUm(contactId, { ...opts, forcar: true }, aoMudar).then((ok) => ok && aoMudar?.()),
      },
    });
    return true;
  }
  const descricao = frasesDaFoto(resultado.foto);
  if (resultado.tipos.length) toast.success(nomesDosTipos(resultado.tipos), { description: descricao });
  else toast.message("Nada do agro por enquanto", { description: descricao });
  return true;
}

export type ResumoDoLote = {
  verificados: number;
  falhas: number;
  mantidosAMao: number;
  naFila: number;
  porTipo: Record<string, number>;
};

/** Verifica vários contatos, 3 por vez (a Evolution não gosta de rajada), contando o andamento. */
export async function verificarVarios(ids: readonly string[], aoAndar: (feitos: number, total: number) => void): Promise<ResumoDoLote> {
  const resumo: ResumoDoLote = { verificados: 0, falhas: 0, mantidosAMao: 0, naFila: 0, porTipo: {} };
  let proximo = 0;
  let feitos = 0;
  const contar = (r: ResultadoDaVerificacaoAgro) => {
    resumo.verificados++;
    if (r.ajusteManualMantido) resumo.mantidosAMao++;
    if (r.foto === "na_fila") resumo.naFila++;
    for (const t of r.tipos) resumo.porTipo[t] = (resumo.porTipo[t] ?? 0) + 1;
  };
  const trabalhador = async () => {
    while (proximo < ids.length) {
      const id = ids[proximo++]!;
      try {
        const { resultado } = await verificarAgroAction(id);
        if (resultado) contar(resultado);
        else resumo.falhas++;
      } catch {
        resumo.falhas++;
      }
      aoAndar(++feitos, ids.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, trabalhador));
  return resumo;
}

/** Frase do fim do lote: quantos foram, o que apareceu e o que ainda espera o Claude. */
export function fraseDoLote(r: ResumoDoLote): { titulo: string; descricao: string } {
  const achados = AGRO_ORDEM.filter((t) => r.porTipo[t]).map((t) => `${r.porTipo[t]} ${AGRO_ROTULO[t]!.toLowerCase()}`);
  const partes = [achados.length ? `Achei: ${achados.join(", ")}.` : "Não achei nada do agro nesses contatos."];
  if (r.naFila) partes.push(`${r.naFila} foto(s) esperam a leitura do Claude.`);
  if (r.mantidosAMao) partes.push(`${r.mantidosAMao} ajustado(s) à mão ficaram como estavam.`);
  if (r.falhas) partes.push(`${r.falhas} não deu para verificar.`);
  return { titulo: `${r.verificados} contato(s) verificado(s)`, descricao: partes.join(" ") };
}
