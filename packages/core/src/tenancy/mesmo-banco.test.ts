import { describe, expect, it } from "vitest";
import { marcasDoBanco, mesmoBanco, problemaDoBancoDoApp } from "@crmagro/config";

/**
 * A URL do papel `crmagro_app` (DATABASE_URL_APP) só pode apontar para o MESMO banco que a DATABASE_URL.
 * Se vazasse a de produção para um teste, o db() falaria com a produção enquanto o basePrisma falava
 * com o banco de teste. Estes testes fixam a regra (pura, sem rede). Docs: a documentação interna.
 */

const DIRETA_A = "postgresql://postgres:segredo@db.abcdefghij.supabase.co:5432/postgres?sslmode=require";
const POOLER_DEDICADO_A = "postgresql://postgres:segredo@db.abcdefghij.supabase.co:6543/postgres?pgbouncer=true&connection_limit=10";
const SUPAVISOR_A = "postgresql://postgres.abcdefghij:segredo@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
const APP_SUPAVISOR_A = "postgresql://crmagro_app.abcdefghij:outra@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
const APP_DIRETA_A = "postgresql://crmagro_app:outra@db.abcdefghij.supabase.co:5432/postgres";
const DIRETA_B = "postgresql://postgres:segredo@db.zzzzzzzzzz.supabase.co:5432/postgres";
const LOCAL = "postgresql://postgres:postgres@localhost:5432/test";
const LOCAL_APP = "postgresql://crmagro_app:rls-teste-local@127.0.0.1:5432/test";

describe("mesmoBanco", () => {
  it("direta, pooler dedicado e Supavisor do MESMO projeto são o mesmo banco (a porta e o usuário não contam)", () => {
    expect(mesmoBanco(DIRETA_A, POOLER_DEDICADO_A)).toBe(true);
    expect(mesmoBanco(DIRETA_A, APP_DIRETA_A)).toBe(true);
    expect(mesmoBanco(SUPAVISOR_A, APP_SUPAVISOR_A)).toBe(true);
    // host direto de um lado, Supavisor do outro: casam pelo <ref> do projeto
    expect(mesmoBanco(DIRETA_A, SUPAVISOR_A)).toBe(true);
    expect(mesmoBanco(APP_DIRETA_A, SUPAVISOR_A)).toBe(true);
  });

  it("projetos diferentes não são o mesmo banco (o vazamento de produção para o teste)", () => {
    expect(mesmoBanco(DIRETA_A, DIRETA_B)).toBe(false);
    expect(mesmoBanco(APP_SUPAVISOR_A, DIRETA_B)).toBe(false);
    expect(mesmoBanco(APP_DIRETA_A, LOCAL)).toBe(false);
  });

  it("o Supavisor tem um host só por região, dividido por todos os projetos: o host igual NÃO basta, vale o projeto", () => {
    const supavisorB = "postgresql://postgres.zzzzzzzzzz:segredo@aws-1-sa-east-1.pooler.supabase.com:6543/postgres";
    expect(mesmoBanco(SUPAVISOR_A, supavisorB)).toBe(false);
    expect(mesmoBanco(APP_SUPAVISOR_A, supavisorB)).toBe(false);
    expect(mesmoBanco(APP_SUPAVISOR_A, SUPAVISOR_A)).toBe(true);
  });

  it("localhost e 127.0.0.1 são o mesmo servidor (a CI usa os dois jeitos)", () => {
    expect(mesmoBanco(LOCAL_APP, LOCAL)).toBe(true);
  });

  it("nome de banco diferente no mesmo servidor não é o mesmo banco", () => {
    expect(mesmoBanco("postgresql://a:b@localhost:5432/test", "postgresql://a:b@localhost:5432/outro")).toBe(false);
  });

  it("URL ausente ou inválida: não dá para garantir, então é falso", () => {
    expect(mesmoBanco(undefined, LOCAL)).toBe(false);
    expect(mesmoBanco("isto não é url", LOCAL)).toBe(false);
  });

  it("as marcas nunca carregam a senha", () => {
    expect(JSON.stringify(marcasDoBanco(DIRETA_A))).not.toContain("segredo");
  });
});

describe("problemaDoBancoDoApp (a guarda dos testes)", () => {
  it("sem DATABASE_URL_APP não há o que conferir", () => {
    expect(problemaDoBancoDoApp({ DATABASE_URL: LOCAL })).toBeNull();
  });

  it("DATABASE_URL_APP do mesmo banco passa (modo RLS da CI e do TESTE)", () => {
    expect(problemaDoBancoDoApp({ DATABASE_URL: LOCAL, DATABASE_URL_APP: LOCAL_APP })).toBeNull();
    expect(problemaDoBancoDoApp({ DATABASE_URL: DIRETA_A, DATABASE_URL_APP: APP_SUPAVISOR_A })).toBeNull();
  });

  it("DATABASE_URL_APP de outro banco é recusada, sem vazar host, usuário nem senha na mensagem", () => {
    const msg = problemaDoBancoDoApp({ DATABASE_URL: DIRETA_B, DATABASE_URL_APP: APP_SUPAVISOR_A });
    expect(msg).toMatch(/DATABASE_URL_APP aponta para um banco DIFERENTE/);
    expect(msg).not.toMatch(/abcdefghij|zzzzzzzzzz|outra|segredo/);
  });

  it("a URL do worker segue a mesma regra", () => {
    expect(problemaDoBancoDoApp({ DATABASE_URL: DIRETA_B, DATABASE_URL_APP_WORKER: APP_SUPAVISOR_A })).toMatch(/DATABASE_URL_APP_WORKER/);
  });

  it("DATABASE_URL_APP sem DATABASE_URL: recusa (não dá para garantir)", () => {
    expect(problemaDoBancoDoApp({ DATABASE_URL_APP: LOCAL_APP })).toMatch(/não dá para garantir/);
  });
});
