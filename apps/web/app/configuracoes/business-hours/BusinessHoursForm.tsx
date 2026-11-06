"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TeamConfigDTO } from "@crmagro/core";

/** Ordem canônica para emitir businessDays (sun..sat) — mantém a string estável. */
const WEEKDAY_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAYS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "sun", label: "Dom" },
  { value: "mon", label: "Seg" },
  { value: "tue", label: "Ter" },
  { value: "wed", label: "Qua" },
  { value: "thu", label: "Qui" },
  { value: "fri", label: "Sex" },
  { value: "sat", label: "Sáb" },
];

const TIMEZONES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "America/Sao_Paulo", label: "America/Sao_Paulo (Brasília)" },
  { value: "America/Manaus", label: "America/Manaus (Manaus)" },
  { value: "America/Cuiaba", label: "America/Cuiaba (Cuiabá)" },
  { value: "America/Porto_Velho", label: "America/Porto_Velho (Porto Velho)" },
  { value: "America/Belem", label: "America/Belem (Belém)" },
  { value: "America/Fortaleza", label: "America/Fortaleza (Fortaleza)" },
  { value: "America/Recife", label: "America/Recife (Recife)" },
  { value: "America/Bahia", label: "America/Bahia (Salvador)" },
  { value: "America/Noronha", label: "America/Noronha (Fernando de Noronha)" },
  { value: "America/New_York", label: "America/New_York (Nova York)" },
  { value: "America/Chicago", label: "America/Chicago (Chicago)" },
  { value: "America/Los_Angeles", label: "America/Los_Angeles (Los Angeles)" },
  { value: "Europe/London", label: "Europe/London (Londres)" },
  { value: "Europe/Lisbon", label: "Europe/Lisbon (Lisboa)" },
  { value: "UTC", label: "UTC" },
];

export function BusinessHoursForm({ initial }: { initial: TeamConfigDTO }) {
  const [respectBusinessHours, setRespectBusinessHours] = useState(initial.respectBusinessHours);
  const [start, setStart] = useState(initial.businessHourStart);
  const [end, setEnd] = useState(initial.businessHourEnd);
  const [days, setDays] = useState<string[]>(initial.businessDays.split(","));
  const [respectHolidays, setRespectHolidays] = useState(initial.respectHolidays);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const bhDisabled = !respectBusinessHours;

  // Garante que o fuso atual (mesmo fora da lista curada) apareça como opção.
  const tzOptions =
    timezone && !TIMEZONES.some((t) => t.value === timezone)
      ? [{ value: timezone, label: timezone }, ...TIMEZONES]
      : TIMEZONES;

  function toggleDay(value: string, checked: boolean) {
    setDays((prev) =>
      checked ? [...prev, value] : prev.filter((d) => d !== value),
    );
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const businessDays = WEEKDAY_ORDER.filter((d) => days.includes(d)).join(",");
      const payload: TeamConfigDTO = {
        respectBusinessHours,
        businessHourStart: start,
        businessHourEnd: end,
        businessDays,
        respectHolidays,
        timezone,
      };

      let res: Response;
      try {
        res = await fetch("/api/configuracoes/business-hours", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {
        setError("Erro de rede ao salvar. Verifique sua conexão e tente novamente.");
        toast.error("Erro de rede ao salvar.");
        return;
      }

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as ApiError;
        setError(formatApiError(data));
        toast.error("Não foi possível salvar a configuração.");
        return;
      }

      const saved = (await res.json()) as TeamConfigDTO;
      // Sincroniza o estado com o que o servidor gravou (fonte da verdade).
      setRespectBusinessHours(saved.respectBusinessHours);
      setStart(saved.businessHourStart);
      setEnd(saved.businessHourEnd);
      setDays(saved.businessDays.split(","));
      setRespectHolidays(saved.respectHolidays);
      setTimezone(saved.timezone);
      toast.success("Configuração salva.");
    });
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      {/* Horário comercial */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-h3">Janela de prospecção</CardTitle>
            <label htmlFor="respect-business-hours" className="flex cursor-pointer items-center gap-2 text-body">
              <Checkbox
                id="respect-business-hours"
                checked={respectBusinessHours}
                onCheckedChange={(v) => setRespectBusinessHours(v === true)}
              />
              Respeitar horário comercial
            </label>
          </div>
        </CardHeader>
        <CardContent className={bhDisabled ? "space-y-4 opacity-50" : "space-y-4"}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bh-start">Abertura</Label>
              <Input
                id="bh-start"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                disabled={bhDisabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bh-end">Fechamento</Label>
              <Input
                id="bh-end"
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                disabled={bhDisabled}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Dias úteis</Label>
            <div className="flex flex-wrap gap-4">
              {WEEKDAYS.map((d) => (
                <label key={d.value} className="flex cursor-pointer items-center gap-1.5 text-body">
                  <Checkbox
                    checked={days.includes(d.value)}
                    onCheckedChange={(v) => toggleDay(d.value, v === true)}
                    disabled={bhDisabled}
                  />
                  {d.label}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Feriados e fuso */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-h3">Feriados e fuso</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="respect-holidays" className="flex cursor-pointer items-center gap-2 text-body">
              <Checkbox
                id="respect-holidays"
                checked={respectHolidays}
                onCheckedChange={(v) => setRespectHolidays(v === true)}
                disabled={bhDisabled}
              />
              Não ligar em feriados nacionais
            </label>
            {bhDisabled && (
              <span className="text-caption text-muted-foreground">
                Disponível só quando o horário comercial está ativo
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tz">Fuso horário</Label>
            <Select value={timezone} onValueChange={setTimezone} disabled={bhDisabled}>
              <SelectTrigger id="tz" className="w-full">
                <SelectValue placeholder="Selecione um fuso" />
              </SelectTrigger>
              <SelectContent>
                {tzOptions.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-caption text-muted-foreground">
              O fuso é usado para interpretar a hora-de-parede dos horários e feriados.
            </p>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? "Salvando..." : "Salvar"}
        </Button>
      </div>
    </form>
  );
}

// ─── Tipos auxiliares p/ erros da API (lib/api mapeia ZodError → 400) ────

type ApiIssue = { path?: string; message?: string };
type ApiError = {
  error?: string;
  message?: string;
  issues?: ApiIssue[];
};

function formatApiError(data: ApiError): string {
  if (data.issues && data.issues.length > 0) {
    return data.issues
      .map((i) => (i.path ? `${i.path}: ${i.message ?? "inválido"}` : (i.message ?? "inválido")))
      .join("; ");
  }
  return data.message ?? data.error ?? "Não foi possível salvar a configuração.";
}
