"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createContactFullAction } from "../actions";
import { PageHeader } from "@/components/ui/page-header";
import { ContatoForm, type DadosDoCadastro } from "../ContatoForm";

/** "Novo contato": o formulário completo (pessoa e empresa) numa página. O do WhatsApp é o mesmo, num pop-up. */
export default function NovoContatoPage() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [existente, setExistente] = useState<string | null>(null);

  function salvar(d: DadosDoCadastro) {
    setExistente(null);
    start(async () => {
      const res = await createContactFullAction({
        person: d.person,
        company: d.company,
        papel: d.papel,
        responsavelId: d.responsavelId,
        relacionamentoStatus: d.relacionamentoStatus,
      });
      if (res.ok && res.id) {
        toast.success("Contato cadastrado");
        router.push(`/contatos/${res.id}`);
      } else {
        if (res.existenteId) setExistente(res.existenteId);
        toast.error("Não foi cadastrado", { description: res.error });
      }
    });
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader breadcrumb={[{ label: "Contatos", href: "/contatos" }]} title="Novo contato" />
      <ContatoForm variante="pagina" statusInicial="novo" salvando={pending} rotuloSalvar="Salvar contato" contatoExistenteId={existente} onSalvar={salvar} />
    </div>
  );
}
