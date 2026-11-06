import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// Guard-rail de bundling (auditoria de escala): um client component ("use client")
// que faça VALUE-import de um pacote Node-only — ou dos barris @crmagro/core /
// @crmagro/channels, que reexportam bullmq/nodemailer/imapflow/playwright — arrasta
// essa pilha pro bundle do NAVEGADOR e quebra o build (502 em produção, já pago 3x).
// `import type` é apagado no build, então é permitido. Server components/actions/
// rotas (sem "use client") continuam livres para usar tudo.
const NODE_ONLY = [
  "@crmagro/core",
  "@crmagro/channels",
  "bullmq",
  "ioredis",
  "nodemailer",
  "imapflow",
  "mailparser",
  "playwright",
  "playwright-core",
];
const clientBoundary = {
  rules: {
    "no-node-only-in-client": {
      meta: {
        type: "problem",
        messages: {
          forbidden:
            "Client component não pode VALUE-import '{{name}}' (Node-only / barrel pesado) — use `import type`, ou mova a lógica para um server component/action. Ver AGENTS.md e a lição do 502.",
        },
      },
      create(context) {
        const sc = context.sourceCode ?? context.getSourceCode();
        const body = sc.ast.body;
        const isClient =
          body.length > 0 &&
          body[0].type === "ExpressionStatement" &&
          body[0].directive === "use client";
        if (!isClient) return {};
        return {
          ImportDeclaration(node) {
            if (node.importKind === "type") return; // `import type ...` é apagado no build
            if (!NODE_ONLY.includes(node.source.value)) return;
            // permite `import { type X }` (todos os specifiers type-only)
            const allType =
              node.specifiers.length > 0 &&
              node.specifiers.every((s) => s.importKind === "type");
            if (!allType) {
              context.report({ node, messageId: "forbidden", data: { name: node.source.value } });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      // Qualquer saída do Next (.next, .next-test…): código gerado.
      "**/.next*/**",
      "**/coverage/**",
      "**/*.config.{js,mjs,cjs,ts}",
      "**/next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Extensão Chrome (MV3): JS puro rodando no navegador, com a API `chrome.*`.
    files: ["apps/extension/**/*.js"],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  {
    // Service worker do Web Push (apps/web/public/sw-push.js): JS puro no navegador.
    files: ["apps/web/public/**/*.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // Scripts utilitários em Node (bootstrap de usuário, backups etc.).
    files: ["**/*.mjs", "**/scripts/**/*.{js,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    plugins: { "crmagro-boundary": clientBoundary },
    rules: { "crmagro-boundary/no-node-only-in-client": "error" },
  },
);
