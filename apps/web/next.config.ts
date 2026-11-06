import type { NextConfig } from "next";

const config: NextConfig = {
  // Não anunciar "x-powered-by: Next.js" (facilita mapear a versão p/ exploits).
  poweredByHeader: false,
  // Packages internos são source-only (TS puro); o Next transpila eles aqui.
  transpilePackages: ["@crmagro/config", "@crmagro/db", "@crmagro/core", "@crmagro/channels"],
  // Pacotes Node-only que NÃO devem ser empacotados pelo webpack (CommonJS,
  // sockets TLS/IMAP, engines nativas): fila (bullmq/ioredis), Playwright, e a
  // pilha de e-mail (nodemailer/imapflow/mailparser) que entra via @crmagro/core →
  // email/service → @crmagro/channels. Externalizar evita a classe de quebra de
  // bundle que já derrubou a produção (502) a cada mudança de webpack/Next.
  serverExternalPackages: [
    "bullmq",
    "ioredis",
    "playwright-core",
    "nodemailer",
    "imapflow",
    "mailparser",
  ],
  // O app não usa next/image. Desligar o otimizador remove o endpoint
  // /_next/image (onde moravam as CVEs críticas do Next 15.5.20) e tira o `sharp`
  // (libvips/libheif, com CVEs próprias) do caminho de requisições externas.
  images: { unoptimized: true },
  experimental: {
    // Server Actions têm limite de corpo de 1 MB por padrão — foto de celular
    // estoura e o envio de mídia falha com 413. Sobe pro teto do bucket (25 MB
    // + folga do multipart). O upload real vai pro Supabase Storage.
    serverActions: { bodySizeLimit: "30mb" },
  },
};

export default config;
