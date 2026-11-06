import { useId, type ComponentType } from "react";
import { Braces, Mail, Plug, Sparkles, Webhook } from "lucide-react";
import { GoogleIcon } from "@/components/google-icon";
import { cn } from "@/lib/utils";
import { marcaDaFerramenta, NOME_DA_MARCA, type MarcaId } from "@/lib/ferramentas";

/**
 * Logos das ferramentas (canais, integrações e provedores de IA).
 *
 * O lucide não tem marcas e não há pacote de logos no projeto, então cada uma
 * é um SVG inline: sem arquivo, sem CSS externo e sem `fill` faltando. Os
 * glifos são versões simplificadas e geométricas; onde não há certeza do
 * traçado oficial (Voopi, GLM, Claude) o desenho é uma marca limpa em cor de
 * marca, não uma cópia. Nectar usa um hexágono neutro.
 *
 * Todo logo aceita `className` (tamanho padrão 20px, sobrescrevível) e `decorativo`:
 * dentro de uma linha que já tem o nome escrito use `decorativo` (escondido do
 * leitor de tela); sozinho ele vira `img` com o nome da marca.
 *
 * Tema escuro: as marcas coloridas usam cores fixas (funcionam nos dois
 * temas); OpenAI e os ícones neutros usam `currentColor`, que acompanha o tema.
 */

export type IconeProps = { className?: string; decorativo?: boolean };
export type Icone = ComponentType<IconeProps>;

/** Cores de marca. */
const COR = {
  whatsapp: "#25D366",
  linkedin: "#0A66C2",
  anthropic: "#D97757",
  glm: "#2F54EB",
  voopi: "#6D4AFF",
  googleAzul: "#4285F4",
  googleVermelho: "#EA4335",
  googleAmarelo: "#FBBC04",
  googleVerde: "#34A853",
  meetVerde: "#00AC47",
  meetVerdeEscuro: "#00832D",
  meetAzul: "#2684FC",
  meetAmarelo: "#FFBA00",
  meetVermelho: "#EA4335",
  nectarTopo: "#FEC20C",
  nectarBase: "#FF8934",
} as const;

/** Acessibilidade: decorativo some do leitor de tela; senão vira imagem nomeada. */
function a11y(nome: string, decorativo?: boolean) {
  return decorativo ? ({ "aria-hidden": true } as const) : ({ role: "img", "aria-label": nome } as const);
}

/** Id de gradiente único por instância (várias marcas na mesma tela não se pisam). */
function useGradId(prefixo: string): string {
  return `${prefixo}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

function Marca({
  nome,
  className,
  decorativo,
  viewBox = "0 0 24 24",
  children,
}: IconeProps & { nome: string; viewBox?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox={viewBox}
      className={cn("h-5 w-5 shrink-0", className)}
      focusable="false"
      {...a11y(nome, decorativo)}
    >
      {children}
    </svg>
  );
}

/** Telefone do Material Icons (24px), usado dentro do balão do WhatsApp e no Voopi. */
const FONE =
  "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z";

export function IconeWhatsApp(p: IconeProps) {
  return (
    <Marca nome="WhatsApp" {...p}>
      <circle cx="12" cy="12" r="11" fill={COR.whatsapp} />
      {/* balão: anel branco com o rabinho embaixo à esquerda */}
      <circle cx="12" cy="11.6" r="6.9" fill="none" stroke="#fff" strokeWidth="1.7" />
      <path d="M5.5 14 4.6 19.5 9.7 18.1Z" fill="#fff" stroke="#fff" strokeWidth="0.8" strokeLinejoin="round" />
      <path d={FONE} fill="#fff" transform="translate(6 5.6) scale(.5)" />
    </Marca>
  );
}

export function IconeInstagram(p: IconeProps) {
  const grad = useGradId("ig");
  return (
    <Marca nome="Instagram" {...p}>
      <defs>
        <linearGradient id={grad} x1="0.05" y1="1" x2="0.95" y2="0">
          <stop offset="0" stopColor="#FFDD55" />
          <stop offset="0.25" stopColor="#FA7E1E" />
          <stop offset="0.5" stopColor="#D62976" />
          <stop offset="0.75" stopColor="#962FBF" />
          <stop offset="1" stopColor="#4F5BD5" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="6.2" fill={`url(#${grad})`} />
      <rect x="5.2" y="5.2" width="13.6" height="13.6" rx="4.2" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3.3" fill="none" stroke="#fff" strokeWidth="1.6" />
      <circle cx="16.2" cy="7.8" r="1" fill="#fff" />
    </Marca>
  );
}

export function IconeLinkedIn(p: IconeProps) {
  return (
    <Marca nome="LinkedIn" {...p}>
      <rect x="1" y="1" width="22" height="22" rx="4.6" fill={COR.linkedin} />
      {/* "in": haste e ponto do i, depois o n */}
      <rect x="5.6" y="9.5" width="2.6" height="8.5" fill="#fff" />
      <circle cx="6.9" cy="6.4" r="1.55" fill="#fff" />
      <path
        d="M10.6 9.5H13.2V10.7C13.7 9.9 14.7 9.3 15.9 9.3 18.1 9.3 18.4 10.9 18.4 13V18H15.8V13.6C15.8 12.4 15.5 11.6 14.5 11.6 13.4 11.6 13.2 12.6 13.2 13.7V18H10.6Z"
        fill="#fff"
      />
    </Marca>
  );
}

/** E-mail genérico (SMTP/IMAP): o envelope do padrão do app. */
export function IconeEmail({ className, decorativo }: IconeProps) {
  return <Mail className={cn("h-5 w-5 shrink-0 text-ink-2", className)} strokeWidth={1.75} {...a11y("E-mail", decorativo)} />;
}

export function IconeGmail(p: IconeProps) {
  return (
    <Marca nome="Gmail" {...p}>
      <rect x="2" y="4.5" width="20" height="15" rx="2" fill="#fff" />
      {/* laterais: azul à esquerda, verde à direita */}
      <path d="M2 7.2 5.6 9.9V19.5H4A2 2 0 0 1 2 17.5Z" fill={COR.googleAzul} />
      <path d="M22 7.2 18.4 9.9V19.5H20A2 2 0 0 0 22 17.5Z" fill={COR.googleVerde} />
      {/* o "M" vermelho */}
      <path d="M2 6.5A2 2 0 0 1 4 4.5H4.4L12 10.4 19.6 4.5H20A2 2 0 0 1 22 6.5V7.2L12 14.7 2 7.2Z" fill={COR.googleVermelho} />
      <path d="M18.4 9.9 22 7.2V6.5A2 2 0 0 0 20 4.5H19.6L18.4 5.4Z" fill={COR.googleAmarelo} />
    </Marca>
  );
}

/** "G" do Google (o componente já existia em components/google-icon.tsx). */
export function IconeGoogle({ className, decorativo }: IconeProps) {
  return decorativo ? (
    <GoogleIcon className={cn("h-5 w-5 shrink-0", className)} />
  ) : (
    <span role="img" aria-label="Google" className="inline-flex">
      <GoogleIcon className={cn("h-5 w-5 shrink-0", className)} />
    </span>
  );
}

export function IconeGoogleAgenda(p: IconeProps) {
  return (
    <Marca nome="Google Agenda" {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2.6" fill="#fff" stroke="#DADCE0" strokeWidth="0.6" />
      {/* moldura em quatro cores: azul (topo e esquerda), verde (base), amarelo (direita) e a dobra vermelha */}
      <path d="M3 5.6A2.6 2.6 0 0 1 5.6 3H18.4A2.6 2.6 0 0 1 21 5.6V8H5V16H3Z" fill={COR.googleAzul} />
      <path d="M3 16H5V19H16V21H5.6A2.6 2.6 0 0 1 3 18.4Z" fill={COR.googleVerde} />
      <path d="M19 8H21V18.4A2.6 2.6 0 0 1 18.4 21H16V19H19Z" fill={COR.googleAmarelo} />
      <path d="M16 21V19H19Z" fill={COR.googleVermelho} />
      {/* "31" simplificado */}
      <g fill="none" stroke={COR.googleAzul} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" transform="translate(1.2 .5)">
        <path d="M8.2 11.4H10.4L9.2 12.9C10.2 12.9 10.9 13.5 10.9 14.4 10.9 15.4 10.1 16.1 9 16.1 8.4 16.1 7.9 15.9 7.6 15.5" />
        <path d="M13 12.4 14.3 11.4V16.1" />
      </g>
    </Marca>
  );
}

export function IconeGoogleMeet(p: IconeProps) {
  return (
    <Marca nome="Google Meet" {...p}>
      {/* corpo da câmera */}
      <rect x="2" y="6" width="14" height="12" rx="2" fill={COR.meetVerde} />
      <path d="M2 8A2 2 0 0 1 4 6H9L2 13Z" fill={COR.meetVermelho} />
      <path d="M2 13V16A2 2 0 0 0 4 18H7.4L2 12.6Z" fill={COR.meetAzul} />
      {/* lente */}
      <path d="M16 10.2 20.7 6.6A.9.9 0 0 1 22 7.3V16.7A.9.9 0 0 1 20.7 17.4L16 13.8Z" fill={COR.meetVerdeEscuro} />
      <path d="M16 10.2 20.7 6.6A.9.9 0 0 1 22 7.3V12H16Z" fill={COR.meetAmarelo} />
    </Marca>
  );
}

export function IconeVoopi(p: IconeProps) {
  return (
    <Marca nome="Voopi" {...p}>
      <rect x="1" y="1" width="22" height="22" rx="6" fill={COR.voopi} />
      <path d={FONE} fill="#fff" transform="translate(5.4 5.4) scale(.55)" />
    </Marca>
  );
}

/** Nectar CRM: hexágono neutro (sem a marca do fornecedor). */
export function IconeNectar(p: IconeProps) {
  return (
    <Marca nome="Nectar CRM" viewBox="0 0 24 24" {...p}>
      <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </Marca>
  );
}

/** Webhooks de entrada e saída: o ícone neutro do lucide. */
export function IconeWebhook({ className, decorativo }: IconeProps) {
  return <Webhook className={cn("h-5 w-5 shrink-0 text-ink-2", className)} strokeWidth={1.75} {...a11y("Webhooks", decorativo)} />;
}

/** API pública: chaves, o ícone neutro do lucide. */
export function IconeApi({ className, decorativo }: IconeProps) {
  return <Braces className={cn("h-5 w-5 shrink-0 text-ink-2", className)} strokeWidth={1.75} {...a11y("API", decorativo)} />;
}

/** Comprimento de cada raio do "brilho" da Anthropic (12 raios, de 30 em 30 graus). */
const RAIOS_CLAUDE = [10.2, 7.6, 9.4, 8, 10.2, 7.4, 9.6, 7.8, 10, 7.6, 9.4, 8.2];

export function IconeAnthropic(p: IconeProps) {
  return (
    <Marca nome="Anthropic (Claude)" {...p}>
      <g stroke={COR.anthropic} strokeWidth="2.2" strokeLinecap="round">
        {RAIOS_CLAUDE.map((r, i) => {
          const a = (i * 30 * Math.PI) / 180;
          return (
            <line
              key={i}
              x1={(12 + 1.8 * Math.cos(a)).toFixed(2)}
              y1={(12 + 1.8 * Math.sin(a)).toFixed(2)}
              x2={(12 + r * Math.cos(a)).toFixed(2)}
              y2={(12 + r * Math.sin(a)).toFixed(2)}
            />
          );
        })}
      </g>
    </Marca>
  );
}

export function IconeOpenAI({ className, decorativo }: IconeProps) {
  return (
    <Marca nome="OpenAI" className={cn("text-foreground", className)} decorativo={decorativo}>
      <path
        fill="currentColor"
        d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997z"
      />
    </Marca>
  );
}

export function IconeGlm(p: IconeProps) {
  return (
    <Marca nome="GLM (z.ai)" {...p}>
      <rect x="1" y="1" width="22" height="22" rx="6" fill={COR.glm} />
      <path d="M7.4 7.9H16.6L7.4 16.1H16.6" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Marca>
  );
}

/** Provedor de IA que o CRM Agro ainda não conhece. */
export function IconeIa({ className, decorativo }: IconeProps) {
  return <Sparkles className={cn("h-5 w-5 shrink-0 text-ink-2", className)} strokeWidth={1.75} {...a11y("Inteligência artificial", decorativo)} />;
}

/** Qualquer outra ferramenta sem logo próprio. */
export function IconeGenerico({ className, decorativo }: IconeProps) {
  return <Plug className={cn("h-5 w-5 shrink-0 text-ink-2", className)} strokeWidth={1.75} {...a11y("Integração", decorativo)} />;
}

/** Um componente por marca; o `Record` faz o compilador acusar marca sem logo. */
const ICONES: Record<MarcaId, Icone> = {
  whatsapp: IconeWhatsApp,
  instagram: IconeInstagram,
  linkedin: IconeLinkedIn,
  email: IconeEmail,
  gmail: IconeGmail,
  google: IconeGoogle,
  "google-agenda": IconeGoogleAgenda,
  "google-meet": IconeGoogleMeet,
  voopi: IconeVoopi,
  nectar: IconeNectar,
  webhook: IconeWebhook,
  api: IconeApi,
  anthropic: IconeAnthropic,
  openai: IconeOpenAI,
  glm: IconeGlm,
  ia: IconeIa,
  generico: IconeGenerico,
};

/**
 * Logo da ferramenta pelo id (canal, integração ou provedor de IA). Id
 * desconhecido cai em `padrao`: o plugue genérico, ou "ia" (brilho) para
 * provedor de IA que ainda não tem logo.
 */
export function iconeDaFerramenta(id: string | null | undefined, padrao: MarcaId = "generico"): Icone {
  return ICONES[marcaDaFerramenta(id, padrao)];
}

/**
 * A caixinha do logo nas linhas de Integrações: 32px, borda de linha, logo
 * centralizado em 20px (mesma medida das antigas siglas).
 */
export function LogoFerramenta({
  id,
  padrao,
  className,
}: {
  id: string | null | undefined;
  padrao?: MarcaId;
  className?: string;
}) {
  const Logo = iconeDaFerramenta(id, padrao);
  return (
    <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line", className)}>
      <Logo decorativo className="h-5 w-5" />
    </span>
  );
}

/** Nome legível da marca (texto alternativo/tooltip). */
export function nomeDaFerramenta(id: string | null | undefined, padrao: MarcaId = "generico"): string {
  return NOME_DA_MARCA[marcaDaFerramenta(id, padrao)];
}
