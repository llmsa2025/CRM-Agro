/**
 * Registro dos conectores de CRM. Fica no código (sem plugin): hoje só o Nectar.
 * Um segundo CRM exige só o adaptador, as capacidades, o mapper e os testes de
 * contrato; o motor (`sync/*`) não muda (plano §4.2).
 */
import type { ConectorCrm } from "./contract";
import { criarConectorNectar } from "./providers/nectarcrm/index";
import type { TransporteNectar } from "./providers/nectarcrm/client";

export function conectorCrm(
  provedor: "nectarcrm",
  deps: { transporte?: TransporteNectar; base?: string } = {},
): ConectorCrm {
  switch (provedor) {
    case "nectarcrm":
      return criarConectorNectar(deps);
  }
}
