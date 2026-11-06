"use client";

import { useId, useRef } from "react";
import type { JanelaEnvio } from "@crmagro/core";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DIAS, NOME_DO_MODO, alternarDia, erroDoHorario, horarioPadraoDoFluxoNovo, trocarModo, type JanelaPropria, type ModoDaJanela } from "./horario";

const ORDEM_DOS_MODOS: ModoDaJanela[] = ["propria", "empresa", "livre"];

/**
 * Horário de envio DESTE fluxo: dias, horas e feriados em que um passo automático (mensagem, e-mail, DM,
 * agente) pode falar com o contato. Aparece na criação do fluxo e no gatilho do editor, e dá para mudar a
 * qualquer hora. Fora do horário o passo não falha: espera a próxima abertura.
 */
export function HorarioDoFluxo({
  value,
  onChange,
  resumoEmpresa,
}: {
  value: JanelaEnvio;
  onChange: (j: JanelaEnvio) => void;
  /** O que "seguir a empresa" significa hoje (vem do servidor, de `resumoDoHorarioDaEmpresa`). */
  resumoEmpresa: string;
}) {
  const id = useId();
  // Guarda o último horário personalizado: trocar de modo e voltar não apaga o que a pessoa montou.
  const ultimaPropria = useRef<JanelaPropria>(value.modo === "propria" ? value : horarioPadraoDoFluxoNovo());
  if (value.modo === "propria") ultimaPropria.current = value;
  const erro = erroDoHorario(value);

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <Label htmlFor={`${id}-modo`}>Horário de envio</Label>
        <p className="text-caption text-ink-3">Quando este fluxo pode falar com o contato. Fora do horário, o passo espera a próxima abertura.</p>
      </div>

      <Select value={value.modo} onValueChange={(m) => onChange(trocarModo(value, m as ModoDaJanela, ultimaPropria.current))}>
        <SelectTrigger id={`${id}-modo`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ORDEM_DOS_MODOS.map((m) => (
            <SelectItem key={m} value={m}>
              {NOME_DO_MODO[m]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {value.modo === "propria" && (
        <div className="space-y-3 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor={`${id}-abre`} className="text-caption">
                Abertura
              </Label>
              <Input id={`${id}-abre`} type="time" value={value.abertura} onChange={(e) => onChange({ ...value, abertura: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-fecha`} className="text-caption">
                Fechamento
              </Label>
              <Input id={`${id}-fecha`} type="time" value={value.fechamento} onChange={(e) => onChange({ ...value, fechamento: e.target.value })} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-caption">Dias</Label>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {DIAS.map((d) => (
                <label key={d.id} className="flex cursor-pointer items-center gap-1.5 text-small">
                  <Checkbox checked={value.dias.includes(d.id)} onCheckedChange={(v) => onChange(alternarDia(value, d.id, v === true))} />
                  {d.rotulo}
                </label>
              ))}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-small">
            <Checkbox checked={value.feriados} onCheckedChange={(v) => onChange({ ...value, feriados: v === true })} />
            Não enviar em feriados nacionais
          </label>
          <p className="text-caption text-ink-3">Vale o fuso da empresa.</p>
        </div>
      )}

      {value.modo === "empresa" && (
        <p className="text-caption text-ink-3">Hoje na empresa: {resumoEmpresa}. Se a empresa mudar o horário, este fluxo muda junto.</p>
      )}

      {value.modo === "livre" && (
        <p className="text-caption text-ink-3">
          Este fluxo envia a qualquer hora, inclusive de madrugada, no fim de semana e em feriado. O contato pode receber mensagem fora de hora.
        </p>
      )}

      {erro && (
        <p role="alert" className="text-caption text-danger-500">
          {erro}
        </p>
      )}
    </div>
  );
}
