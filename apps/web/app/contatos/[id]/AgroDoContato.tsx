"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Loader2, Sprout } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SectionHeader } from "@/components/ui/page-header";
import { daysSince } from "@/lib/format";
import { ajustarAgroAction } from "../actions";
import { AGRO_ORDEM, AGRO_ROTULO, AgroPills, FotoNaFila, frasesDaFoto, verificarUm, type EstadoDaFotoAgro } from "../agro";

/** O que a ficha sabe da última verificação (já validado no servidor; sem imagem, telefone nem link da foto). */
export type AgroDaFicha = {
  tipos: string[];
  detalhe: {
    origem: "automatica" | "manual";
    verificadoEm: string;
    foto: EstadoDaFotoAgro | null;
    evidencias: { tipo: string | null; fonte: string; peso: number; texto: string }[];
  } | null;
};

/** Seção "No agro" da ficha do contato: o que ele é, por quê, e os botões de verificar e de ajustar à mão. */
export function AgroDoContato({ contactId, agro, podeEditar }: { contactId: string; agro: AgroDaFicha; podeEditar: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { tipos, detalhe } = agro;
  const manual = detalhe?.origem === "manual";
  const depois = () => router.refresh();

  function verificar(opts: { refazerFoto?: boolean; forcar?: boolean } = {}) {
    startTransition(async () => {
      if (await verificarUm(contactId, opts, depois)) depois();
    });
  }

  function alternar(tipo: string, ligado: boolean) {
    const novos = AGRO_ORDEM.filter((t) => (t === tipo ? ligado : tipos.includes(t)));
    startTransition(async () => {
      const r = await ajustarAgroAction(contactId, [...novos]);
      if (r.error) toast.error("Não deu para ajustar", { description: r.error });
      else depois();
    });
  }

  const evidencias = detalhe?.evidencias ?? [];
  const aviso = frasesDaFoto(detalhe?.foto ?? null);

  return (
    <section aria-labelledby="t-agro">
      <SectionHeader id="t-agro" variant="aside" title="No agro" />
      <div className="flex flex-col gap-2.5 pt-3">
        {tipos.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <AgroPills tipos={tipos} />
          </div>
        ) : (
          <p className="text-small text-ink-2">{detalhe ? "Nada do agro encontrado." : "Ainda não verificado."}</p>
        )}

        {detalhe && (
          <p className="text-caption text-ink-3">
            {manual ? "Ajustado à mão" : "Verificado"} {daysSince(detalhe.verificadoEm)}
          </p>
        )}
        {detalhe?.foto === "na_fila" ? <FotoNaFila comTexto /> : aviso && <p className="text-caption text-ink-3">{aviso}</p>}

        {evidencias.length > 0 && (
          <details className="group text-small">
            <summary className="cursor-pointer list-none text-ink-2 hover:text-foreground">
              <span className="inline-flex items-center gap-1">
                Por quê
                <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden />
              </span>
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1.5 text-caption text-ink-2">
              {evidencias.map((e, i) => (
                <li key={i} className={e.peso === 0 ? "text-ink-3" : undefined}>
                  {e.texto}
                </li>
              ))}
            </ul>
          </details>
        )}

        {podeEditar && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => verificar({ forcar: manual })} disabled={pending}>
              {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sprout className="mr-1.5 h-4 w-4" />}
              {manual ? "Voltar ao automático" : "Verificar agro"}
            </Button>
            {detalhe && detalhe.foto !== "na_fila" && !manual && (
              <Button variant="ghost-subtle" size="sm" onClick={() => verificar({ refazerFoto: true })} disabled={pending} title="Olha a foto do WhatsApp de novo">
                Refazer a foto
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost-subtle" size="sm" disabled={pending}>
                  Ajustar
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>O que ele é</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {AGRO_ORDEM.map((t) => (
                  <DropdownMenuCheckboxItem key={t} checked={tipos.includes(t)} onCheckedChange={(v) => alternar(t, Boolean(v))} onSelect={(e) => e.preventDefault()}>
                    {AGRO_ROTULO[t]}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </section>
  );
}
