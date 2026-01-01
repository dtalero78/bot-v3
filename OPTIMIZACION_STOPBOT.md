# Optimización de Consultas stopBot en PostgreSQL

## Análisis del Problema Actual

### Flujo Actual (index.js línea 946)
```javascript
const conversationData = await getConversationFromDB(from);
if (conversationData.stopBot) {
    // No procesar mensaje
    return res.status(200).json({ status: 'ok', message: 'Bot stopped for this user' });
}
```

### Qué Hace `getConversationFromDB()` (líneas 205-254)
1. Llama `getOrCreateConversationPostgres(userId)` - trae **todos los campos** de la tabla
2. Hace petición HTTP a Wix para obtener mensajes e historial
3. Combina datos de ambas fuentes
4. Retorna objeto completo con `stopBot`, `mensajes`, `observaciones`, `threadId`, `pgConvId`

### Problema de Eficiencia Detectado

**Para verificar stopBot, el sistema:**
- ✅ Consulta PostgreSQL (SELECT de 8 columnas)
- ❌ Hace petición HTTP a Wix (red externa, latencia alta)
- ❌ Procesa mensajes que no se necesitan para verificar stopBot
- ❌ UPDATE adicional a `fecha_ultima_actividad` en PostgreSQL

**Impacto:**
- **Latencia alta**: ~200-500ms por HTTP a Wix + query PostgreSQL completo
- **Sobrecarga**: Se traen datos innecesarios (mensajes, observaciones, threadId)
- **Writes innecesarios**: UPDATE a `fecha_ultima_actividad` aunque solo queremos leer stopBot

---

## Soluciones Propuestas

### Opción 1: Función Lightweight Solo para stopBot (RECOMENDADA)

**Ventajas:**
- ✅ Query mínimo: solo 2 campos (celular, stopBot)
- ✅ Sin llamadas HTTP a Wix
- ✅ Sin UPDATE a fecha_ultima_actividad
- ✅ Latencia reducida: ~5-10ms vs ~200-500ms actual
- ✅ Fácil de implementar

**Implementación:**

```javascript
/**
 * Verificar stopBot de forma eficiente (sin llamadas externas ni updates)
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
```

**Uso en webhook:**

```javascript
// index.js línea 946 (ANTES)
const conversationData = await getConversationFromDB(from);
if (conversationData.stopBot) {
    console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
    return res.status(200).json({
        status: 'ok',
        message: 'Bot stopped for this user'
    });
}

// index.js línea 946 (DESPUÉS - OPTIMIZADO)
const isStopBot = await checkStopBot(from);
if (isStopBot) {
    console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
    return res.status(200).json({
        status: 'ok',
        message: 'Bot stopped for this user'
    });
}
```

---

### Opción 2: Cache en Memoria (Para Alto Volumen)

**Ventajas:**
- ✅ Latencia ultra-baja: ~1ms para hits de cache
- ✅ Reduce carga en PostgreSQL
- ✅ Ideal si hay usuarios con muchos mensajes consecutivos

**Desventajas:**
- ⚠️ Requiere invalidación manual cuando cambia stopBot
- ⚠️ Memoria adicional (mínima: ~100 bytes por usuario)

**Implementación:**

```javascript
// Cache simple con TTL de 5 minutos
const stopBotCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

async function checkStopBotWithCache(celular) {
  // 1. Verificar cache
  const cached = stopBotCache.get(celular);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`📦 Cache hit para ${celular}: stopBot=${cached.value}`);
    return cached.value;
  }

  // 2. Si no está en cache, consultar PostgreSQL
  const stopBot = await checkStopBot(celular); // Usa función de Opción 1

  // 3. Guardar en cache
  stopBotCache.set(celular, {
    value: stopBot,
    timestamp: Date.now()
  });

  console.log(`💾 Cache miss para ${celular}: stopBot=${stopBot} (guardado)`);
  return stopBot;
}

// Al actualizar stopBot, invalidar cache
async function updateStopBotPostgres(celular, stopBot) {
  const result = await pool.query(`
    UPDATE conversaciones_whatsapp
    SET "stopBot" = $1, fecha_ultima_actividad = NOW()
    WHERE celular = $2
  `, [stopBot, celular]);

  // Invalidar cache
  stopBotCache.delete(celular);
  console.log(`🗑️ Cache invalidado para ${celular}`);

  return result.rowCount > 0;
}
```

---

### Opción 3: Índice en PostgreSQL (Complementario)

**Ventajas:**
- ✅ Acelera queries de stopBot
- ✅ Sin cambios en código
- ✅ Beneficia todas las consultas de stopBot

**Implementación:**

```sql
-- Índice compuesto para optimizar lookup de stopBot
CREATE INDEX idx_conversaciones_stopbot_lookup
ON conversaciones_whatsapp (celular, "stopBot")
WHERE estado != 'cerrada';

-- Índice adicional para ordenamiento
CREATE INDEX idx_conversaciones_ultima_actividad
ON conversaciones_whatsapp (celular, fecha_ultima_actividad DESC)
WHERE estado != 'cerrada';
```

**Verificar que existe índice único en celular:**
```sql
-- Ya debe existir desde la migración
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'conversaciones_whatsapp';
```

---

## Recomendación Final

### Implementar en 2 Fases:

#### Fase 1 (Inmediata - Alta Prioridad)
✅ **Opción 1**: Crear función `checkStopBot()` lightweight
✅ **Opción 3**: Crear índices en PostgreSQL

**Beneficios:**
- Reducción de latencia: ~95% (de 200-500ms a 5-10ms)
- Sin cambios arquitectónicos complejos
- Fácil de testear y desplegar

#### Fase 2 (Opcional - Si hay Alto Volumen)
✅ **Opción 2**: Agregar cache en memoria

**Cuándo implementar:**
- Si el bot recibe >100 mensajes/min
- Si hay usuarios con ráfagas de mensajes consecutivos
- Si PostgreSQL muestra carga alta en queries de stopBot

---

## Plan de Implementación

### Paso 1: Crear función optimizada
```bash
# Editar index.js y agregar función checkStopBot()
```

### Paso 2: Crear índices en PostgreSQL
```bash
# Ejecutar script SQL para crear índices
```

### Paso 3: Modificar webhook para usar nueva función
```bash
# Cambiar línea 946 de index.js
```

### Paso 4: Verificar mejora
```bash
# Comparar logs de latencia antes/después
# Verificar que stopBot sigue funcionando correctamente
```

---

## Métricas de Éxito

### Antes (Estado Actual)
- Latencia promedio: **200-500ms**
- Componentes:
  - PostgreSQL SELECT (8 columnas): ~10ms
  - HTTP a Wix: ~150-400ms
  - UPDATE fecha_ultima_actividad: ~5ms
  - Procesamiento: ~5ms

### Después (Con Optimización)
- Latencia promedio: **5-10ms**
- Componentes:
  - PostgreSQL SELECT (1 columna): ~5-10ms
  - Sin HTTP a Wix: 0ms ✅
  - Sin UPDATE: 0ms ✅
  - Sin procesamiento: 0ms ✅

**Mejora:** ~95% reducción en latencia (~20-50x más rápido)

---

## Consideraciones Adicionales

### ¿Qué pasa con la sincronización Wix?
- ✅ No afecta: stopBot se sigue actualizando en Wix via `updateStopBotOnly()`
- ✅ La verificación solo lee, no escribe
- ✅ PostgreSQL sigue siendo fuente de verdad

### ¿Y si PostgreSQL falla?
- ✅ La función retorna `false` (fail-safe: bot activo)
- ✅ El bot puede seguir funcionando
- ✅ Error se logea para debugging

### ¿Afecta otras funcionalidades?
- ✅ No: `getConversationFromDB()` sigue existiendo para cuando se necesiten mensajes
- ✅ Solo cambia la verificación inicial de stopBot
- ✅ Resto del flujo sin cambios
