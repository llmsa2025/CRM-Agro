import { describe, it, expect, vi } from "vitest";
import { rowsToCsv, getColumnLabels, EXPORT_COLUMNS, type ExportRow } from "./export";

vi.mock("@crmagro/db", () => ({
  db: vi.fn(),
}));

vi.mock("papaparse", () => ({
  default: {
    unparse: vi.fn((data: { fields: string[]; data: string[][] }) => {
      const header = data.fields.join(",");
      const rows = data.data.map((r) => r.join(",")).join("\n");
      return `${header}\n${rows}`;
    }),
  },
}));

describe("contacts export", () => {
  const mockRows: ExportRow[] = [
    {
      nome: "João Silva",
      telefone: "+551188888888",
      email: "joao@example.com",
      cidade: "São Paulo",
      estado: "SP",
      empresa: "Tech Ltda",
      cargo: "CEO",
      status: "novo",
      interesse: "nao_avaliado",
      origem: "csv",
      tags: "cliente, premium",
      createdAt: "2026-07-24",
    },
    {
      nome: "Maria Souza",
      telefone: "",
      email: "",
      cidade: "Rio de Janeiro",
      estado: "RJ",
      empresa: "",
      cargo: "",
      status: "cliente",
      interesse: "interessado",
      origem: "",
      tags: "",
      createdAt: "2026-07-23",
    },
  ];

  describe("getColumnLabels", () => {
    it("retorna labels das colunas em ordem", () => {
      const labels = getColumnLabels();
      expect(labels).toEqual([
        "Nome",
        "Telefone",
        "Email",
        "Cidade",
        "Estado",
        "Empresa",
        "Cargo",
        "Status",
        "Interesse",
        "Origem",
        "Tags",
        "Criado em",
      ]);
    });
  });

  describe("EXPORT_COLUMNS", () => {
    it("tem 12 colunas", () => {
      expect(EXPORT_COLUMNS).toHaveLength(12);
    });
  });

  describe("rowsToCsv", () => {
    it("gera CSV com header e linhas", () => {
      const csv = rowsToCsv(mockRows);
      // Header
      expect(csv).toContain("Nome,Telefone,Email");
      // Dados
      expect(csv).toContain("João Silva");
      expect(csv).toContain("Maria Souza");
      expect(csv).toContain("São Paulo");
    });

    it("gera CSV vazio com apenas header se não há linhas", () => {
      const csv = rowsToCsv([]);
      expect(csv).toContain("Nome,Telefone,Email");
      // papaparse pode adicionar linha vazia — verifica que contém o header
      expect(csv.split("\n").length).toBeLessThanOrEqual(2);
    });
  });
});
