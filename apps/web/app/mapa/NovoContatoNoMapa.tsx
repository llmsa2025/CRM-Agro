"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createContactFromMapAction, type ContatoCriadoNoMapa } from "./actions";

const SEM_CAMADA = "__none__";

/**
 * Pop-up "Criar contato aqui" (botão direito no mapa): nome, telefone, e-mail,
 * empresa e, opcionais, área (ha), faturamento anual e camada. A posição vem
 * do clique; cidade/UF são preenchidos pelo servidor a partir do ponto quando
 * a geocodificação reversa está disponível.
 */
export function NovoContatoNoMapa({
  ponto,
  camadas,
  onClose,
  onCreated,
}: {
  ponto: { lat: number; lng: number } | null;
  camadas: { id: string; nome: string; cor: string }[];
  onClose: () => void;
  onCreated: (c: ContatoCriadoNoMapa) => void;
}) {
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [empresa, setEmpresa] = useState("");
  const [area, setArea] = useState("");
  const [faturamento, setFaturamento] = useState("");
  const [camadaId, setCamadaId] = useState(SEM_CAMADA);
  const [pending, start] = useTransition();

  function limpar() {
    setNome("");
    setTelefone("");
    setEmail("");
    setEmpresa("");
    setArea("");
    setFaturamento("");
    setCamadaId(SEM_CAMADA);
  }

  function salvar() {
    if (!ponto || !nome.trim()) return;
    start(async () => {
      const r = await createContactFromMapAction({
        nome: nome.trim(),
        telefone: telefone.trim() || undefined,
        email: email.trim() || undefined,
        empresa: empresa.trim() || undefined,
        latitude: ponto.lat,
        longitude: ponto.lng,
        // O servidor entende "1.250" e "2,5".
        areaHa: area.trim() || undefined,
        faturamentoAnual: faturamento.trim() || undefined,
        camadaId: camadaId === SEM_CAMADA ? undefined : camadaId,
      });
      if (r.ok) {
        toast.success(`${r.contact.nome} criado no mapa`, {
          description: r.contact.cidade ? `${r.contact.cidade}${r.contact.estado ? ` · ${r.contact.estado}` : ""}` : "Sem cidade reconhecida no ponto. Complete na ficha se quiser.",
        });
        limpar();
        onCreated(r.contact);
      } else toast.error("Não deu para criar o contato", { description: r.error });
    });
  }

  return (
    <Dialog
      open={ponto !== null}
      onOpenChange={(v) => {
        if (!v) {
          limpar();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo contato neste ponto</DialogTitle>
          <DialogDescription className="num">
            {ponto ? `${ponto.lat.toFixed(5)}, ${ponto.lng.toFixed(5)}` : ""} · a cidade e a UF vêm do ponto, quando reconhecidas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="nc-nome">Nome</Label>
            <Input id="nc-nome" autoFocus value={nome} onChange={(e) => setNome(e.target.value)} onKeyDown={(e) => e.key === "Enter" && salvar()} placeholder="Nome do produtor ou responsável" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="nc-tel">Telefone / WhatsApp</Label>
              <Input id="nc-tel" inputMode="tel" value={telefone} onChange={(e) => setTelefone(e.target.value)} placeholder="66 99999-0000" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nc-email">E-mail</Label>
              <Input id="nc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="nome@fazenda.com.br" />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-empresa">Empresa / fazenda</Label>
            <Input id="nc-empresa" value={empresa} onChange={(e) => setEmpresa(e.target.value)} placeholder="Fazenda Boa Vista" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="nc-area">Área (ha)</Label>
              <Input id="nc-area" inputMode="decimal" value={area} onChange={(e) => setArea(e.target.value)} placeholder="1.250" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="nc-fat">Faturamento anual (R$)</Label>
              <Input id="nc-fat" inputMode="decimal" value={faturamento} onChange={(e) => setFaturamento(e.target.value)} placeholder="2.400.000" />
            </div>
          </div>
          {camadas.length > 0 && (
            <div className="grid gap-1.5">
              <Label htmlFor="nc-camada">Camada</Label>
              <Select value={camadaId} onValueChange={setCamadaId}>
                <SelectTrigger id="nc-camada">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SEM_CAMADA}>Sem camada</SelectItem>
                  {camadas.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full" style={{ background: c.cor }} aria-hidden />
                        {c.nome}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              limpar();
              onClose();
            }}
          >
            Cancelar
          </Button>
          <Button onClick={salvar} disabled={pending || !nome.trim()}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Criar contato
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
