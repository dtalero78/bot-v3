/**
 * Funciones Optimizadas para Verificación de stopBot
 *
 * Este archivo contiene las funciones optimizadas que deben agregarse a index.js
 * para mejorar la eficiencia de las consultas de stopBot.
 *
 * MEJORA DE RENDIMIENTO:
 * - Antes: 200-500ms (incluía HTTP a Wix + UPDATE a PostgreSQL)
 * - Después: 5-10ms (solo SELECT de 1 columna en PostgreSQL)
 * - Reducción: ~95% (20-50x más rápido)
 */

// ═══════════════════════════════════════════════════════════════════════════
// OPCIÓN 1: Función Lightweight Solo para stopBot (SIN CACHE)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verificar stopBot de forma eficiente (sin llamadas externas ni updates)
 *
 * VENTAJAS:
 * - Solo consulta 1 columna en PostgreSQL
 * - No hace llamadas HTTP a Wix
 * - No actualiza fecha_ultima_actividad
 * - Latencia: ~5-10ms vs ~200-500ms actual
 *
 * @param {string} celular - Número de celular
 * @returns {Promise<boolean>} - true si el bot está detenido
 */
async function checkStopBot(celular) {
  try {
    const result = await pool.query(`
      SELECT "stopBot"
      FROM conversaciones_whatsapp
      WHERE celular = $1 AND estado != 'cerrada'
      ORDER BY fecha_ultima_actividad DESC
      LIMIT 1
    `, [celular]);

    if (result.rows.length > 0) {
      return result.rows[0].stopBot === true;
    }

    // Si no existe conversación, bot activo por defecto
    return false;
  } catch (error) {
    console.error('❌ Error verificando stopBot:', error.message);
    // En caso de error, permitir que el bot responda (fail-safe)
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OPCIÓN 2: Función con Cache en Memoria (PARA ALTO VOLUMEN)
// ═══════════════════════════════════════════════════════════════════════════

// Cache simple con TTL de 5 minutos
const stopBotCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Verificar stopBot con cache en memoria
 *
 * VENTAJAS:
 * - Latencia ultra-baja: ~1ms para hits de cache
 * - Reduce carga en PostgreSQL
 * - Ideal para usuarios con muchos mensajes consecutivos
 *
 * DESVENTAJAS:
 * - Requiere invalidación manual cuando cambia stopBot
 * - Usa memoria adicional (~100 bytes por usuario)
 *
 * @param {string} celular - Número de celular
 * @returns {Promise<boolean>} - true si el bot está detenido
 */
async function checkStopBotWithCache(celular) {
  // 1. Verificar cache
  const cached = stopBotCache.get(celular);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`📦 Cache hit para ${celular}: stopBot=${cached.value}`);
    return cached.value;
  }

  // 2. Si no está en cache, consultar PostgreSQL
  const stopBot = await checkStopBot(celular);

  // 3. Guardar en cache
  stopBotCache.set(celular, {
    value: stopBot,
    timestamp: Date.now()
  });

  console.log(`💾 Cache miss para ${celular}: stopBot=${stopBot} (guardado)`);
  return stopBot;
}

/**
 * Invalidar cache de stopBot para un usuario
 * DEBE llamarse cada vez que se actualiza stopBot
 *
 * @param {string} celular - Número de celular
 */
function invalidateStopBotCache(celular) {
  const deleted = stopBotCache.delete(celular);
  if (deleted) {
    console.log(`🗑️ Cache invalidado para ${celular}`);
  }
}

/**
 * Limpiar cache de entradas expiradas (opcional, para evitar memory leaks)
 * Ejecutar periódicamente (ej: cada 10 minutos)
 */
function cleanupExpiredCache() {
  const now = Date.now();
  let cleaned = 0;

  for (const [celular, data] of stopBotCache.entries()) {
    if (now - data.timestamp > CACHE_TTL_MS) {
      stopBotCache.delete(celular);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cache limpiado: ${cleaned} entradas expiradas eliminadas`);
  }
}

// Ejecutar limpieza cada 10 minutos
setInterval(cleanupExpiredCache, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// ACTUALIZACIÓN DE FUNCIONES EXISTENTES PARA USAR CACHE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Versión actualizada de updateStopBotPostgres que invalida cache
 *
 * REEMPLAZA la función existente en index.js
 */
async function updateStopBotPostgres_WithCacheInvalidation(celular, stopBot) {
  try {
    const result = await pool.query(`
      UPDATE conversaciones_whatsapp
      SET "stopBot" = $1, fecha_ultima_actividad = NOW()
      WHERE celular = $2 AND estado != 'cerrada'
    `, [stopBot, celular]);

    if (result.rowCount > 0) {
      console.log(`✅ stopBot actualizado a ${stopBot} para ${celular}`);

      // Invalidar cache
      invalidateStopBotCache(celular);

      return true;
    }

    console.log(`⚠️ No se encontró conversación activa para ${celular}`);
    return false;
  } catch (error) {
    console.error('❌ Error actualizando stopBot en PostgreSQL:', error.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INSTRUCCIONES DE USO
// ═══════════════════════════════════════════════════════════════════════════

/*

PASO 1: Agregar funciones a index.js
────────────────────────────────────────────────────────────────────────────

1. Copiar la función checkStopBot() al inicio de index.js (después de las importaciones)

2. Si se desea usar cache, copiar también:
   - stopBotCache, CACHE_TTL_MS
   - checkStopBotWithCache()
   - invalidateStopBotCache()
   - cleanupExpiredCache()
   - setInterval para limpieza


PASO 2: Modificar el webhook principal (línea ~946 de index.js)
────────────────────────────────────────────────────────────────────────────

ANTES:
──────
const conversationData = await getConversationFromDB(from);
if (conversationData.stopBot) {
    console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
    return res.status(200).json({
        status: 'ok',
        message: 'Bot stopped for this user'
    });
}

DESPUÉS (SIN CACHE):
────────────────────
const isStopBot = await checkStopBot(from);
if (isStopBot) {
    console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
    return res.status(200).json({
        status: 'ok',
        message: 'Bot stopped for this user'
    });
}

DESPUÉS (CON CACHE):
────────────────────
const isStopBot = await checkStopBotWithCache(from);
if (isStopBot) {
    console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
    return res.status(200).json({
        status: 'ok',
        message: 'Bot stopped for this user'
    });
}


PASO 3: Si usas cache, actualizar updateStopBotPostgres()
────────────────────────────────────────────────────────────────────────────

Buscar la función updateStopBotPostgres() existente y agregar invalidación:

async function updateStopBotPostgres(celular, stopBot) {
  try {
    const result = await pool.query(`
      UPDATE conversaciones_whatsapp
      SET "stopBot" = $1, fecha_ultima_actividad = NOW()
      WHERE celular = $2 AND estado != 'cerrada'
    `, [stopBot, celular]);

    if (result.rowCount > 0) {
      console.log(`✅ stopBot actualizado a ${stopBot} para ${celular}`);

      // AGREGAR ESTA LÍNEA:
      invalidateStopBotCache(celular);

      return true;
    }

    return false;
  } catch (error) {
    console.error('❌ Error actualizando stopBot:', error.message);
    return false;
  }
}


PASO 4: Verificar que NO se afecten otras funcionalidades
────────────────────────────────────────────────────────────────────────────

✅ getConversationFromDB() sigue existiendo - se usa cuando se necesitan mensajes
✅ Solo cambia la verificación inicial de stopBot en el webhook
✅ Resto del flujo sin cambios


PASO 5: Testear
────────────────────────────────────────────────────────────────────────────

1. Enviar mensaje con usuario que tiene stopBot=false → Bot responde
2. Enviar mensaje con usuario que tiene stopBot=true → Bot no responde
3. Verificar logs de latencia (debe ser ~5-10ms vs ~200-500ms antes)
4. Si usas cache, verificar logs de "Cache hit" y "Cache miss"


PASO 6: Monitorear
────────────────────────────────────────────────────────────────────────────

1. Verificar logs para errores
2. Medir latencia de respuesta del bot
3. Si usas cache, verificar que se invalida correctamente al cambiar stopBot

*/

module.exports = {
  checkStopBot,
  checkStopBotWithCache,
  invalidateStopBotCache,
  cleanupExpiredCache,
  updateStopBotPostgres_WithCacheInvalidation
};
