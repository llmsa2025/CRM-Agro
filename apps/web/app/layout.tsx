import type { ReactNode } from "react";
import { headers } from "next/headers";
import type { Metadata } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/theme-provider";
import { AppChrome } from "@/components/app-chrome";
import { TELAS, temTela } from "@/lib/telas";
import { currentUser, runAsUser } from "@/lib/tenant";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { CommandMenu } from "@/components/command-menu";
import { countUnreadConversations } from "@crmagro/core";
import "./globals.css";

// Tipografia da identidade v2: Instrument Sans (interface) + Newsreader (títulos
// e números de destaque). Os arquivos ficam no repositório (app/fontes/, licença
// OFL ao lado) e o next/font/local serve do próprio site: sem request externo em
// runtime e sem "pulo" de fonte. Antes vinham do Google Fonts NO BUILD, e às vezes
// o Google devolvia um link sem extensão e o build quebrava ("Cannot read
// properties of null (reading '1')" no next/font, visto na Vercel em 08/10/2026).
// São fontes variáveis (um arquivo cobre todos os pesos), recorte "latin" do
// Google (U+0000-00FF e afins: todo o português); letra de outro alfabeto cai na
// fonte de reserva.
const sans = localFont({
  src: [{ path: "./fontes/instrument-sans-latin.woff2", weight: "400 600", style: "normal" }],
  variable: "--font-sans",
  display: "swap",
});
const serif = localFont({
  src: [{ path: "./fontes/newsreader-latin.woff2", weight: "300 500", style: "normal" }],
  variable: "--font-serif",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

// NOTA: havia aqui `export const preferredRegion = "gru1"` (commit ddc2fbb).
// Removido no rebuild tudo-no-VPS: é config exclusiva da Vercel (sem efeito num
// Next self-hosted) e quebrava o prerender do /404 no `next build`.
// A colocação geográfica agora é física — o app roda em São Paulo.

export const metadata: Metadata = {
  title: "CRM Agro",
  description: "Plataforma de Prospecção",
};

/**
 * Conversas não lidas para o contador do menu (cacheado 30 s no core).
 * Best-effort: qualquer falha esconde o contador em vez de derrubar a página.
 * O bloco do WhatsApp saiu do menu a pedido do dono (27/09); o estado da conta
 * fica em Integrações e a queda avisa por Web Push/e-mail.
 */
async function naoLidasDoMenu(): Promise<number> {
  try {
    return await runAsUser(async () => countUnreadConversations().catch(() => 0));
  } catch {
    return 0;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Nonce da CSP desta requisição (nasce no middleware, lib/csp.ts). O Next já o põe nos scripts dele
  // sozinho; o script em linha do next-themes (tema sem "piscar") só recebe se a gente repassar. Sem
  // CSP (modo desligada) o cabeçalho não existe e fica undefined, como antes.
  const cabecalhos = await headers();
  const nonce = cabecalhos.get("x-nonce") ?? undefined;
  // Identidade da sessão para o menu de usuário. Null em /login.
  const usuario = await currentUser();
  const naoLidas = usuario ? await naoLidasDoMenu() : 0;
  // Telas por pessoa (F2b): o menu mostra só as liberadas (a rota e a ação também barram).
  const telas = usuario ? TELAS.map((t) => t.id).filter((id) => temTela(usuario.role, usuario.modulos, id)) : null;

  return (
    <html lang="pt-BR" suppressHydrationWarning className={`${sans.variable} ${serif.variable}`}>
      <body className="min-h-screen font-sans text-body">
        <ThemeProvider attribute="class" defaultTheme="light" disableTransitionOnChange nonce={nonce}>
          <TooltipProvider delayDuration={200}>
            <AppChrome
              usuario={usuario ? { name: usuario.name, email: usuario.email, role: usuario.role } : null}
              naoLidas={naoLidas}
              telas={telas}
            >
              {children}
            </AppChrome>
            <Toaster />
            <CommandMenu telas={telas} />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
