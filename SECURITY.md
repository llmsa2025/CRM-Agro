# Segurança

## Reportar uma vulnerabilidade

Abra um **aviso de segurança privado** no GitHub (aba *Security > Report a vulnerability*) em vez de uma issue pública. Descreva o problema, como reproduzir e o impacto. Não publique detalhes antes da correção.

## Boas práticas ao rodar o seu

- O `.env` nunca vai para o git. Se um segredo vazar, gere outro e troque.
- Faça cópia das chaves (`CREDENTIALS_ENCRYPTION_KEY`, `CONTATOS_INDICE_KEY`) **fora do servidor**: perder a chave é perder o acesso aos dados cifrados.
- Em produção defina `WHATSAPP_WEBHOOK_TOKEN`. Sem ele, o webhook recusa tudo (fail-closed).
- PostgreSQL e Redis ficam presos em `127.0.0.1` no `docker-compose.yml`. Se expuser para a internet, use senha forte e firewall.
- Troque a senha padrão do Postgres do compose antes de guardar dados reais.
- Os dados de demonstração e o usuário `demo@crmagro.example` são só para teste. Não use em produção.
- Mantenha as dependências atualizadas (`pnpm audit`) e o `CSP_MODO` em `aplicada` depois de conferir os relatórios.

## Uso responsável

Este é um software de prospecção. Quem o opera responde pelo uso:

- **LGPD:** tenha base legal para tratar os dados dos contatos, ofereça opt-out e respeite os pedidos de exclusão. O CRM tem um controle de opt-out (marcar o contato como "não quer contato") que os fluxos e as campanhas consultam. A conformidade com a LGPD continua sendo de quem opera.
- **WhatsApp:** a Evolution API usa o protocolo não oficial. Envio em massa pode banir o número. Respeite os limites diários do CRM e, para volume alto, use a API oficial.
- **Captação e automação de redes sociais:** raspar sites e redes sociais, ou automatizar uma sessão logada, pode contrariar os termos deles e levar a bloqueio, medidas legais ou responsabilidade pelo tratamento de dados. Os recursos de Google Maps, Instagram e LinkedIn são experimentais. Prefira fontes públicas e respeite `robots.txt` e limites de taxa.
