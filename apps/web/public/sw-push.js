/*
 * Service worker de Web Push do CRM Agro (avisos com a aba fechada: WhatsApp caiu,
 * motor degradado, lembrete da agenda). Só trata push — não faz cache nem
 * intercepta requisições (nada de "offline" aqui).
 *
 * Registro pela tela: navigator.serviceWorker.register("/sw-push.js").
 * Payload (core/push/service.ts): { titulo, corpo, url?, tag? }.
 */

self.addEventListener("install", () => {
  // Versão nova assume sem esperar as abas antigas fecharem.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch {
    dados = { corpo: event.data ? event.data.text() : "" };
  }
  const titulo = typeof dados.titulo === "string" && dados.titulo ? dados.titulo : "CRM Agro";
  const opcoes = {
    body: typeof dados.corpo === "string" ? dados.corpo : "",
    data: { url: typeof dados.url === "string" ? dados.url : "/" },
    lang: "pt-BR",
  };
  // Mesma tag substitui o aviso anterior (ex.: "WhatsApp caiu" repetido).
  if (typeof dados.tag === "string" && dados.tag) {
    opcoes.tag = dados.tag;
    opcoes.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

/** Só navega dentro do próprio CRM Agro: URL de outra origem vira a página inicial. */
function urlSegura(bruta) {
  try {
    const u = new URL(bruta || "/", self.location.origin);
    return u.origin === self.location.origin ? u.href : self.location.origin + "/";
  } catch {
    return self.location.origin + "/";
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destino = urlSegura(event.notification.data && event.notification.data.url);
  event.waitUntil(
    (async () => {
      const abas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reaproveita uma aba do CRM Agro aberta em vez de abrir outra.
      for (const aba of abas) {
        if (new URL(aba.url).origin === self.location.origin && "focus" in aba) {
          if ("navigate" in aba) await aba.navigate(destino).catch(() => undefined);
          return aba.focus();
        }
      }
      return self.clients.openWindow(destino);
    })(),
  );
});

// O navegador trocou a assinatura (expirou/rotacionou): assina de novo com a
// mesma chave e avisa o servidor, senão os avisos param em silêncio.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const chave = event.oldSubscription && event.oldSubscription.options.applicationServerKey;
      const nova =
        event.newSubscription ||
        (chave ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave }) : null);
      if (!nova) return;
      await fetch("/api/push/assinatura", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nova.toJSON()),
      });
    })().catch(() => undefined),
  );
});
