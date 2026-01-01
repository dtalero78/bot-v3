# Migración de WHP desde Wix a PostgreSQL

Este documento describe el proceso de migración de datos de la colección **WHP** (conversaciones WhatsApp) desde Wix CMS hacia PostgreSQL para el bot BSL.

## Tabla Migrada

| Tabla Wix | Tabla PostgreSQL | Registros (~) | Campos Clave |
|-----------|------------------|---------------|--------------|
| WHP | conversaciones_whatsapp | 34,000+ | userId (celular), stopBot |

---

## Endpoint de Wix Requerido

Necesitas crear un nuevo endpoint en Wix para exportar los datos de WHP.

### 1. Exportar WHP

**URL:** `https://www.bsl.com.co/_functions/exportarWHP`

**Parámetros:**
| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `skip` | number | Registros a saltar (paginación) |
| `limit` | number | Máximo 1000 por restricción de Wix (recomendado 500) |

**Ejemplo:**
```
GET /_functions/exportarWHP?skip=0&limit=500
```

**Respuesta:**
```json
{
  "success": true,
  "items": [
    {
      "_id": "abc123...",
      "userId": "573001234567",
      "nombre": "Juan Pérez",
      "stopBot": true,
      "_createdDate": "2025-01-01T10:00:00.000Z",
      "_updatedDate": "2025-01-01T12:00:00.000Z"
    }
  ],
  "count": 500,
  "totalCount": 34000,
  "skip": 0,
  "hasMore": true,
  "nextSkip": 500
}
```

---

## Código a Agregar en Wix

### backend/exposeDataBase.js

Agrega esta función:

```javascript
/**
 * Exportar WHP (conversaciones WhatsApp)
 * @param {number} skip - Registros a saltar
 * @param {number} limit - Máximo de registros (máx 1000)
 * @returns {Promise<Object>}
 */
export async function exportarWHP(skip = 0, limit = 500) {
    try {
        // Validar límites
        const limitNum = Math.min(Math.max(1, limit), 1000);
        const skipNum = Math.max(0, skip);

        // Query a la colección WHP
        let query = wixData.query("WHP")
            .skip(skipNum)
            .limit(limitNum);

        // Ejecutar query
        const results = await query.find();

        // Obtener conteo total
        const totalCount = results.totalCount;

        // Mapear items solo con campos necesarios para migración
        const items = results.items.map(item => ({
            _id: item._id,
            userId: item.userId,
            nombre: item.nombre || null,
            stopBot: item.stopBot === true,
            _createdDate: item._createdDate,
            _updatedDate: item._updatedDate
        }));

        return {
            success: true,
            items: items,
            count: items.length,
            totalCount: totalCount,
            skip: skipNum,
            hasMore: (skipNum + items.length) < totalCount,
            nextSkip: skipNum + items.length
        };

    } catch (error) {
        console.error("Error en exportarWHP:", error);
        return {
            success: false,
            error: error.message,
            items: [],
            count: 0,
            totalCount: 0,
            skip: skip,
            hasMore: false
        };
    }
}
```

### backend/http-functions.js

Agrega este endpoint HTTP:

```javascript
/**
 * GET /exportarWHP
 * Exporta registros de la colección WHP para migración
 */
export async function get_exportarWHP(request) {
    try {
        const { skip = '0', limit = '500' } = request.query;
        const skipNum = parseInt(skip, 10);
        const limitNum = parseInt(limit, 10);

        const resultado = await exportarWHP(skipNum, limitNum);

        return {
            body: resultado,
            headers: {
                "Content-Type": "application/json"
            },
            status: 200
        };

    } catch (error) {
        console.error("Error en get_exportarWHP:", error);
        return {
            body: {
                success: false,
                error: error.message
            },
            headers: {
                "Content-Type": "application/json"
            },
            status: 500
        };
    }
}
```

---

## Script de Migración

El script `migracion-whp.js` se encarga de:
1. Fetch data desde Wix en lotes de 500 registros
2. Mapeo de campos:
   - `userId` (Wix) → `celular` (PostgreSQL)
   - `stopBot` (Wix) → `stopBot` (PostgreSQL)
   - `nombre` (Wix) → `nombre_paciente` (PostgreSQL)
   - `_id` (Wix) → `wix_whp_id` (PostgreSQL)
3. UPSERT en PostgreSQL (INSERT o UPDATE si ya existe por `celular`)
4. Marca registros con `origen = 'WIX'`

### Uso del Script

```bash
# Modo prueba (solo 1000 registros)
node migracion-whp.js --test

# Verificar sin hacer cambios
node migracion-whp.js --dry-run

# Migración completa
node migracion-whp.js

# Verificar conteos después de migración
node migracion-whp.js --verify

# Continuar desde un punto específico (si se interrumpió)
node migracion-whp.js --skip=10000
```

### Configuración del Script

- **Lotes de Wix:** 500 registros (ajustable)
- **Pausa entre lotes:** 3 segundos
- **Reintentos:** 5 intentos con backoff exponencial
- **Timeout:** 3 minutos por petición
- **Procesamiento paralelo:** 10 registros simultáneos

---

## Mapeo de Campos

| Campo Wix | Campo PostgreSQL | Tipo | Notas |
|-----------|------------------|------|-------|
| `_id` | `wix_whp_id` | VARCHAR(100) | ID único de Wix |
| `userId` | `celular` | VARCHAR(20) | Número de WhatsApp (clave única) |
| `nombre` | `nombre_paciente` | VARCHAR(255) | Nombre del paciente |
| `stopBot` | `stopBot` | BOOLEAN | Si el bot está pausado |
| `_createdDate` | `fecha_inicio` | TIMESTAMP | Fecha de creación |
| `_updatedDate` | `fecha_ultima_actividad` | TIMESTAMP | Última actualización |
| - | `estado` | VARCHAR(50) | Fijado como 'migrada' |
| - | `canal` | VARCHAR(50) | Fijado como 'bot' |
| - | `bot_activo` | BOOLEAN | Inverso de stopBot |
| - | `origen` | VARCHAR(20) | Fijado como 'WIX' |

---

## Estrategia de UPSERT

El script usa `ON CONFLICT (celular) DO UPDATE` para:
- **Insertar** registros nuevos (celular no existe en PostgreSQL)
- **Actualizar** registros existentes (celular ya existe):
  - Actualiza `stopBot`, `bot_activo`, `nombre_paciente`
  - Preserva `wix_whp_id` si no estaba
  - Actualiza `fecha_ultima_actividad` y `updated_at`

```sql
INSERT INTO conversaciones_whatsapp (...)
VALUES (...)
ON CONFLICT (celular) DO UPDATE SET
    wix_whp_id = COALESCE(EXCLUDED.wix_whp_id, conversaciones_whatsapp.wix_whp_id),
    nombre_paciente = COALESCE(EXCLUDED.nombre_paciente, conversaciones_whatsapp.nombre_paciente),
    "stopBot" = EXCLUDED."stopBot",
    bot_activo = EXCLUDED.bot_activo,
    fecha_ultima_actividad = EXCLUDED.fecha_ultima_actividad,
    updated_at = NOW()
```

---

## Pasos para Ejecutar la Migración

### 1. Configurar Endpoint en Wix
- Agregar código a `backend/exposeDataBase.js`
- Agregar endpoint HTTP a `backend/http-functions.js`
- Publicar cambios en Wix

### 2. Probar Endpoint
```bash
curl "https://www.bsl.com.co/_functions/exportarWHP?skip=0&limit=10"
```

Deberías recibir:
```json
{
  "success": true,
  "items": [...],
  "count": 10,
  "totalCount": 34000,
  ...
}
```

### 3. Ejecutar Migración en Modo Prueba
```bash
node migracion-whp.js --test
```

Esto procesa solo 1000 registros para verificar que todo funciona.

### 4. Ejecutar Migración Completa
```bash
node migracion-whp.js
```

### 5. Verificar Resultados
```bash
node migracion-whp.js --verify
```

---

## Troubleshooting

### Error: HTTP 404 Not Found
El endpoint `exportarWHP` no existe en Wix. Verifica que:
- Agregaste el código a `backend/exposeDataBase.js`
- Agregaste el endpoint a `backend/http-functions.js`
- Publicaste los cambios en Wix

### Error: HTTP 504 Gateway Timeout
Wix tiene límite de tiempo de ejecución. Soluciones:
- Reducir `BATCH_SIZE` de 500 a 200
- El script reintenta automáticamente

### Error: "duplicate key value violates unique constraint"
No debería ocurrir con UPSERT, pero si pasa:
- El script actualizará el registro existente en lugar de fallar
- Verifica que no haya celulares duplicados en Wix

### Registros Faltantes
Verificar conteos:
```bash
node migracion-whp.js --verify
```

Si faltan registros, continuar desde donde quedó:
```bash
node migracion-whp.js --skip=10000
```

---

## Diferencias con Otras Migraciones

| Característica | HistoriaClinica | Formularios | WHP |
|----------------|-----------------|-------------|-----|
| Registros | 108,000+ | 76,000+ | 34,000+ |
| Batch Size | 1000 | 200 | 500 |
| Delay | 2s | 4s | 3s |
| Timeout | 2min | 3min | 3min |
| Tabla destino | HistoriaClinica | formularios | conversaciones_whatsapp |
| Clave única | _id | _id | celular |
| Campos complejos | examenes (array) | firmas (base64) | stopBot (boolean) |

---

## Verificación Post-Migración

Después de la migración, ejecuta estas queries para validar:

```sql
-- Conteo total
SELECT COUNT(*) FROM conversaciones_whatsapp;

-- Registros con stopBot=true
SELECT COUNT(*) FROM conversaciones_whatsapp WHERE "stopBot" = true;

-- Registros migrados desde Wix
SELECT COUNT(*) FROM conversaciones_whatsapp WHERE origen = 'WIX';

-- Últimos 10 registros migrados
SELECT celular, nombre_paciente, "stopBot", estado, fecha_inicio
FROM conversaciones_whatsapp
ORDER BY fecha_ultima_actividad DESC
LIMIT 10;

-- Verificar duplicados
SELECT celular, COUNT(*) as count
FROM conversaciones_whatsapp
GROUP BY celular
HAVING COUNT(*) > 1;
```

---

## Historial de Migraciones

| Fecha | Tipo | Registros WHP | Notas |
|-------|------|---------------|-------|
| [Pendiente] | Inicial | ~34,000 | Migración masiva completa |

---

## Notas Importantes

1. **No se migran mensajes**: Solo se transfieren celular, nombre y stopBot. Los mensajes permanecen en Wix.

2. **stopBot es crítico**: Este campo controla si el bot responde o no. La migración garantiza que se preserve correctamente.

3. **UPSERT por celular**: Si un celular ya existe en PostgreSQL, se actualiza su stopBot en lugar de crear duplicado.

4. **origen = 'WIX'**: Todos los registros migrados se marcan con origen WIX para distinguirlos de registros creados en PostgreSQL.

5. **Estado 'migrada'**: Los registros migrados se marcan con estado 'migrada' para diferenciarlos de conversaciones nuevas.

6. **bot_activo vs stopBot**: Son inversos. Si stopBot=true, entonces bot_activo=false.
