/* ══════════════════════════════════════════════════════════════
   🔔 SERVICE WORKER — RutaEscolar v5
   ══════════════════════════════════════════════════════════════
   
   Este Service Worker maneja:
   ✅ Notificaciones nativas (incluso con pantalla apagada)
   ✅ Cache offline para que la PWA cargue sin internet
   ✅ Click en notificaciones → abrir la app
   ✅ Polling independiente de Supabase (background)
   ✅ Sonido + vibración en notificaciones
   ✅ Badge de notificaciones no leídas
   
   ══════════════════════════════════════════════════════════════ */

var CACHE_NAME = 'rutaescolar-v5';
var CACHE_URLS = [
  '/',
  '/index.html',
  '/portal.html',
  '/icon-192.jpg',
  '/icon-512.jpg'
];

/* ═══════════════════════════════════════════════
   📦 INSTALL — Cachear archivos esenciales
   ═══════════════════════════════════════════════ */
self.addEventListener('install', function(event) {
  self.skipWaiting(); /* Activar inmediatamente */
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_URLS).catch(function() {
        /* Si falla algún archivo, no bloquear la instalación */
        return Promise.resolve();
      });
    })
  );
});

/* ═══════════════════════════════════════════════
   ✅ ACTIVATE — Limpiar caches viejos
   ═══════════════════════════════════════════════ */
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(n) { return n !== CACHE_NAME; })
             .map(function(n) { return caches.delete(n); })
      );
    }).then(function() {
      return self.clients.claim(); /* Tomar control de todas las pestañas */
    })
  );
});

/* ═══════════════════════════════════════════════
   🌐 FETCH — Cache-first para archivos, 
   network-first para API
   ═══════════════════════════════════════════════ */
self.addEventListener('fetch', function(event) {
  var url = event.request.url;
  
  /* No cachear requests de Supabase ni APIs externas */
  if (url.indexOf('supabase') >= 0 || 
      url.indexOf('api.') >= 0 ||
      url.indexOf('cdn.') >= 0 ||
      url.indexOf('unpkg.com') >= 0 ||
      url.indexOf('cdnjs.') >= 0) {
    return; /* Dejar pasar al network normal */
  }
  
  /* Para archivos de la app: cache-first con fallback a network */
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        /* Cachear la respuesta para futuro uso offline */
        if (response && response.status === 200 && response.type === 'basic') {
          var responseToCache = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      }).catch(function() {
        /* Offline fallback */
        if (event.request.destination === 'document') {
          return caches.match('/index.html') || caches.match('/portal.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

/* ═══════════════════════════════════════════════
   📨 MESSAGE — Recibir comandos de la página
   
   La página envía mensajes cuando detecta nuevas
   notificaciones para que el SW las muestre como
   notificaciones nativas del sistema operativo.
   
   Esto funciona incluso con la pantalla apagada
   en Android (si la PWA está instalada).
   ═══════════════════════════════════════════════ */
self.addEventListener('message', function(event) {
  if (!event.data) return;
  
  /* ── SHOW_NOTIF: Mostrar notificación nativa ── */
  if (event.data.type === 'SHOW_NOTIF') {
    var title = event.data.title || '🚐 RutaEscolar';
    var body = event.data.body || 'Tienes un nuevo aviso';
    var url = event.data.url || '/';
    var ntype = event.data.ntype || 'default';
    
    /* Patrón de vibración según tipo */
    var vibPatterns = {
      en_camino:  [200, 100, 200, 100, 300],
      en_puerta:  [300, 100, 300, 100, 500, 100, 300],
      entregado:  [150, 80, 150, 80, 400],
      ausencia_hoy: [200, 80, 200],
      cancelar_ausencia: [150, 60, 150],
      pago_confirmado: [200, 100, 200]
    };
    
    var opts = {
      body: body,
      icon: '/icon-192.jpg',
      badge: '/icon-192.jpg',
      tag: 'ruta-' + ntype + '-' + Date.now(),
      renotify: true,            /* Siempre notificar aunque haya un tag existente */
      requireInteraction: true,   /* No auto-cerrar — queda hasta que el usuario toque */
      silent: false,              /* Permitir sonido del sistema */
      vibrate: vibPatterns[ntype] || [200, 80, 200, 80, 300],
      data: { url: url, ntype: ntype, timestamp: Date.now() },
      actions: [
        { action: 'open', title: '🚐 Abrir App' },
        { action: 'dismiss', title: '✕ Cerrar' }
      ]
    };
    
    event.waitUntil(
      self.registration.showNotification(title, opts).catch(function(err) {
        console.warn('SW: Error mostrando notificación:', err);
      })
    );
    return;
  }
  
  /* ── SETUP_POLLING: Configurar polling de Supabase ── */
  if (event.data.type === 'SETUP_POLLING') {
    _sbUrl = event.data.sbUrl;
    _sbKey = event.data.sbKey;
    _studentId = event.data.studentId;
    _lastNfId = event.data.lastNfId || null;
    _portalUrl = event.data.portalUrl || '/portal.html';
    
    /* Iniciar polling si tenemos datos */
    if (_sbUrl && _sbKey && _studentId) {
      _startPolling();
    }
    return;
  }
  
  /* ── STOP_POLLING: Detener polling ── */
  if (event.data.type === 'STOP_POLLING') {
    _stopPolling();
    return;
  }
  
  /* ── UPDATE_LAST_NF: Actualizar último ID de notificación ── */
  if (event.data.type === 'UPDATE_LAST_NF') {
    _lastNfId = event.data.lastNfId;
    return;
  }
});

/* ═══════════════════════════════════════════════
   👆 NOTIFICATION CLICK — Abrir la app
   ═══════════════════════════════════════════════ */
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  
  var action = event.action;
  if (action === 'dismiss') return;
  
  var url = (event.notification.data && event.notification.data.url) || '/';
  
  event.waitUntil(
    /* Buscar si ya hay una ventana abierta de la app */
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clients) {
      /* Si ya hay una ventana abierta, enfocarla */
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client.url.indexOf(self.registration.scope) >= 0 && 'focus' in client) {
          client.focus();
          /* Enviar mensaje a la página para que refresque */
          client.postMessage({ type: 'NOTIFICATION_CLICK', url: url });
          return;
        }
      }
      /* Si no hay ventana, abrir una nueva */
      if (self.clients.openWindow) {
        return self.clients.openWindow(url);
      }
    })
  );
});

/* Cuando se cierra la notificación sin hacer click */
self.addEventListener('notificationclose', function(event) {
  /* Podríamos registrar analytics aquí */
});

/* ═══════════════════════════════════════════════
   📡 POLLING INDEPENDIENTE DE SUPABASE
   
   El SW puede consultar Supabase directamente
   usando fetch() incluso cuando la página NO 
   está visible. Esto es CLAVE para que las
   notificaciones funcionen con pantalla apagada.
   
   Funciona así:
   1. La página envía SETUP_POLLING con credenciales
   2. El SW consulta Supabase cada 5 segundos
   3. Si hay nueva notificación → showNotification()
   4. También notifica a la página vía postMessage
   ═══════════════════════════════════════════════ */
var _sbUrl = null;
var _sbKey = null;
var _studentId = null;
var _lastNfId = null;
var _portalUrl = '/portal.html';
var _pollTimer = null;
var _pollInterval = 5000; /* 5 segundos */

function _startPolling() {
  _stopPolling();
  _pollTimer = setInterval(function() {
    _checkNewNotifications();
  }, _pollInterval);
  /* Primera verificación inmediata */
  _checkNewNotifications();
}

function _stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function _checkNewNotifications() {
  if (!_sbUrl || !_sbKey || !_studentId) return;
  
  var url = _sbUrl + '/rest/v1/notifications?student_id=eq.' + _studentId 
    + '&from_role=eq.driver&order=created_at.desc&limit=1';
  
  fetch(url, {
    headers: {
      'apikey': _sbKey,
      'Authorization': 'Bearer ' + _sbKey,
      'Content-Type': 'application/json'
    }
  })
  .then(function(response) { return response.json(); })
  .then(function(data) {
    if (!data || data.length === 0) return;
    var newest = data[0];
    
    /* ¿Es nueva? */
    if (_lastNfId && newest.id !== _lastNfId) {
      _lastNfId = newest.id;
      
      /* Generar título y cuerpo */
      var cfg = {
        en_camino:  { t: '🚐 ¡Furgón en camino!', b: newest.message || 'El furgón viene en camino' },
        en_puerta:  { t: '🏠 ¡Furgón en tu puerta!', b: newest.message || 'Sal ahora, el furgón espera' },
        entregado:  { t: '✅ Entregado', b: newest.message || 'Tu hijo llegó al destino' },
        pago_confirmado: { t: '💰 Pago confirmado', b: newest.message || 'Pago registrado' }
      };
      var info = cfg[newest.ntype] || { t: '🔔 Aviso del furgón', b: newest.message || newest.ntype };
      
      /* Mostrar notificación nativa */
      var vibPatterns = {
        en_camino:  [200, 100, 200, 100, 300],
        en_puerta:  [300, 100, 300, 100, 500, 100, 300],
        entregado:  [150, 80, 150, 80, 400]
      };
      
      self.registration.showNotification(info.t, {
        body: info.b,
        icon: '/icon-192.jpg',
        badge: '/icon-192.jpg',
        tag: 'ruta-bg-' + newest.ntype,
        renotify: true,
        requireInteraction: true,
        silent: false,
        vibrate: vibPatterns[newest.ntype] || [200, 80, 200],
        data: { url: _portalUrl, ntype: newest.ntype, fromPolling: true }
      }).catch(function() {});
      
      /* Notificar a la página si está abierta */
      self.clients.matchAll({ type: 'window' }).then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({
            type: 'NEW_NOTIFICATION',
            notification: newest
          });
        });
      });
    } else if (!_lastNfId && newest.id) {
      /* Primera vez — solo guardar el ID, no notificar */
      _lastNfId = newest.id;
    }
  })
  .catch(function(err) {
    /* Silenciar errores de red — reintentar en el siguiente ciclo */
  });
}

/* ═══════════════════════════════════════════════
   🔄 PERIODIC BACKGROUND SYNC (Chrome Android)
   
   Chrome en Android permite "periodic background sync"
   que se ejecuta aunque la PWA esté cerrada.
   Esto es lo MÁS CERCANO a notificaciones push
   sin un servidor push dedicado.
   ═══════════════════════════════════════════════ */
self.addEventListener('periodicsync', function(event) {
  if (event.tag === 'check-notifications') {
    event.waitUntil(_checkNewNotifications());
  }
});

/* ═══════════════════════════════════════════════
   ⚡ PUSH EVENT — Para futuro uso con servidor push
   Si algún día se agrega un servidor push con VAPID,
   este handler mostrará las notificaciones.
   ═══════════════════════════════════════════════ */
self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { body: event.data.text() }; } catch (e2) {}
  }
  
  var title = data.title || '🚐 RutaEscolar';
  var opts = {
    body: data.body || 'Tienes un nuevo aviso del furgón',
    icon: '/icon-192.jpg',
    badge: '/icon-192.jpg',
    tag: 'ruta-push-' + Date.now(),
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [300, 100, 300, 100, 500],
    data: { url: data.url || '/', ntype: data.ntype || 'push' }
  };
  
  event.waitUntil(
    self.registration.showNotification(title, opts)
  );
});
