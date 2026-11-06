import Link from "next/link";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TELAS } from "@/lib/telas";

/** Tela bloqueada pelas "telas por pessoa" (F2b): o administrador libera em Configurações → Equipe. */
export default async function SemAcessoPage({ searchParams }: { searchParams: Promise<{ tela?: string }> }) {
  const { tela } = await searchParams;
  const nome = TELAS.find((t) => t.id === tela)?.label;
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-24 text-center">
      <Lock className="h-8 w-8 text-ink-3" aria-hidden />
      <h1 className="font-serif text-h1">Você não tem acesso {nome ? `a ${nome}` : "a esta tela"}</h1>
      <p className="text-body text-ink-2">Peça ao administrador da sua empresa para liberar em Configurações → Equipe.</p>
      <Button asChild>
        <Link href="/">Ir para o Painel</Link>
      </Button>
    </div>
  );
}
