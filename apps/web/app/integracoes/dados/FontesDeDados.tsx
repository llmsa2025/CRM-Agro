"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { FontePagaDTO } from "@crmagro/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusDot } from "@/components/ui/status-dot";
import { centavosParaReais, reaisParaCentavos } from "@/lib/fonte-paga";
import { removerFontePagaAction, salvarFontePagaAction } from "./actions";

export function FontesDeDados({ fontes, podeEditar }: { fontes: FontePagaDTO[]; podeEditar: boolean }) {
  return (
    <div className="max-w-2xl space-y-8">
      {!podeEditar && <p className="text-body text-muted-foreground">Só administradores ligam e desligam fontes de dados.</p>}
      {fontes.map((f) => (
        <Fonte key={f.id} fonte={f} podeEditar={podeEditar} />
      ))}
    </div>
  );
}

function Fonte({ fonte, podeEditar }: { fonte: FontePagaDTO; podeEditar: boolean }) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [chave, setChave] = useState("");
  const [preco, setPreco] = useState(fonte.precoCreditoCentavos !== null ? (fonte.precoCreditoCentavos / 100).toFixed(2).replace(".", ",") : "");
  const [tetoBusca, setTetoBusca] = useState(String(fonte.tetoCreditosPorBusca));
  const [tetoMes, setTetoMes] = useState(fonte.tetoCreditosMes !== null ? String(fonte.tetoCreditosMes) : "");

  function salvar() {
    const centavos = reaisParaCentavos(preco);
    if (centavos === "invalido") return toast.error("Preço inválido", { description: "Use um valor em reais, como 0,75." });
    const porBusca = Number(tetoBusca);
    const porMes = tetoMes.trim() ? Number(tetoMes) : null;
    if (!Number.isInteger(porBusca) || porBusca < 1) return toast.error("O teto por busca precisa ser um número de 1 a 100.");
    if (porMes !== null && (!Number.isInteger(porMes) || porMes < 1)) return toast.error("O teto do mês precisa ser um número inteiro.");
    if (!chave.trim() && !fonte.ligada) return toast.error("Cole a chave da fonte.");
    iniciar(async () => {
      const r = await salvarFontePagaAction(fonte.id, {
        apiKey: chave.trim(), // em branco numa fonte ligada = manter a chave atual (o servidor resolve)
        precoCreditoCentavos: centavos,
        tetoCreditosPorBusca: porBusca,
        tetoCreditosMes: porMes,
      });
      if (r.error) {
        toast.error("Não foi possível salvar", { description: r.error });
        return;
      }
      setChave("");
      toast.success("Fonte ligada", { description: "Nenhuma consulta foi feita agora." });
      router.refresh();
    });
  }
  function desligar() {
    iniciar(async () => {
      const r = await removerFontePagaAction(fonte.id);
      if (r.error) {
        toast.error("Não foi possível desligar", { description: r.error });
        return;
      }
      toast.success("Fonte desligada e chave apagada");
      router.refresh();
    });
  }

  return (
    <section aria-labelledby={`t-${fonte.id}`} className="space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
        <div>
          <h2 id={`t-${fonte.id}`} className="text-body font-medium">{fonte.nome}</h2>
          <p className="text-small text-ink-2">Busca de pessoas por nome. Cada 10 pessoas lidas custam 1 crédito.</p>
        </div>
        <StatusDot tone={fonte.ligada ? "ok" : "empty"}>{fonte.ligada ? "Ligada" : "Desligada"}</StatusDot>
      </div>

      {fonte.ligada && (
        <p className="num text-small text-ink-2">
          Chave {fonte.chaveMascarada}. Créditos usados neste mês: {fonte.usoDoMes}
          {fonte.tetoCreditosMes !== null ? ` de ${fonte.tetoCreditosMes}` : ""}.
          {fonte.precoCreditoCentavos !== null ? ` Crédito a ${centavosParaReais(fonte.precoCreditoCentavos)}.` : ""}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`k-${fonte.id}`}>{fonte.ligada ? "Nova chave de API" : "Chave de API"}</Label>
          <Input id={`k-${fonte.id}`} type="password" autoComplete="off" disabled={!podeEditar} value={chave} onChange={(e) => setChave(e.target.value)} placeholder={fonte.ligada ? "Deixe em branco para manter a atual" : "Cole a chave"} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`p-${fonte.id}`}>Preço de um crédito (R$)</Label>
          <Input id={`p-${fonte.id}`} inputMode="decimal" disabled={!podeEditar} value={preco} onChange={(e) => setPreco(e.target.value)} placeholder="Opcional, como 0,75" />
          <p className="text-caption text-muted-foreground">Sem o preço, o CRM Agro mostra só os créditos.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`tb-${fonte.id}`}>Teto de créditos por busca</Label>
          <Input id={`tb-${fonte.id}`} inputMode="numeric" disabled={!podeEditar} value={tetoBusca} onChange={(e) => setTetoBusca(e.target.value.replace(/\D/g, ""))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`tm-${fonte.id}`}>Teto de créditos por mês</Label>
          <Input id={`tm-${fonte.id}`} inputMode="numeric" disabled={!podeEditar} value={tetoMes} onChange={(e) => setTetoMes(e.target.value.replace(/\D/g, ""))} placeholder="Opcional" />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={salvar} disabled={pendente || !podeEditar}>{fonte.ligada ? "Salvar" : "Ligar fonte"}</Button>
        {fonte.ligada && (
          <Button variant="ghost" onClick={desligar} disabled={pendente || !podeEditar} className="text-destructive hover:text-destructive">
            Desligar e apagar a chave
          </Button>
        )}
      </div>
      <p className="text-caption text-muted-foreground">
        A chave fica cifrada e só administradores usam a fonte. Antes de cada consulta o CRM Agro mostra o custo e pede a confirmação. Cada
        consulta fica registrada (quem, quando e por quê), sem o nome completo.
      </p>
    </section>
  );
}
