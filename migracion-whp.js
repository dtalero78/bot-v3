/**
 * Script de Migración: WHP de Wix a PostgreSQL conversaciones_whatsapp
 *
 * Este script migra registros de la colección WHP desde Wix CMS
 * a la tabla conversaciones_whatsapp en PostgreSQL.
 *
 * Uso:
 *   node migracion-whp.js [--skip=N] [--dry-run] [--verify] [--test]
 *
 * Opciones:
 *   --skip=N      Continuar desde el registro N (útil si se interrumpió)
 *   --dry-run     Solo mostrar lo que se haría, sin insertar
 *   --verify      Verificar conteos después de migración
 *   --test        Modo prueba: solo 1000 registros
 *
 * Ejemplo:
 *   node migracion-whp.js --test
 *   node migracion-whp.js
 */

require('dotenv').config();
const { Pool } = require('pg');

// Configuración de la base de datos PostgreSQL
const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
});

// URL base de Wix
const WIX_BASE_URL = 'https://www.bsl.com.co/_functions';

// Configuración de migración
const BATCH_SIZE = 500; // Registros por lote de Wix
const DELAY_BETWEEN_BATCHES_MS = 3000; // Pausa entre lotes (3 segundos)

// Argumentos de línea de comandos
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verifyOnly = args.includes('--verify');
const testMode = args.includes('--test'); // Solo 1000 registros para prueba
const skipArg = args.find(a => a.startsWith('--skip='));
const skipStart = skipArg ? parseInt(skipArg.split('=')[1], 10) : 0;
const maxRecords = testMode ? 1000 : Infinity;

// Estadísticas
const stats = {
    totalFetched: 0,
    totalInserted: 0,
    totalUpdated: 0,
    totalSkipped: 0,
    totalErrors: 0,
    startTime: null,
    endTime: null,
    errors: []
};

/**
 * Crear tabla conversaciones_whatsapp si no existe
 */
async function verificarTablaConversaciones() {
    console.log('\n📊 Verificando tabla conversaciones_whatsapp...');

    try {
        // Verificar que la tabla existe
        const countResult = await pool.query('SELECT COUNT(*) FROM conversaciones_whatsapp');
        console.log(`✅ Tabla conversaciones_whatsapp existe`);
        console.log(`📈 Registros actuales en PostgreSQL: ${countResult.rows[0].count}`);

        // Verificar si existe constraint UNIQUE en celular
        const constraintCheck = await pool.query(`
            SELECT constraint_name
            FROM information_schema.table_constraints
            WHERE table_name = 'conversaciones_whatsapp'
            AND constraint_type = 'UNIQUE'
            AND constraint_name LIKE '%celular%'
        `);

        if (constraintCheck.rows.length === 0) {
            console.log('⚠️  No se encontró constraint UNIQUE en celular');
            console.log('⚠️  Creando constraint UNIQUE para permitir UPSERT...');

            // Crear constraint UNIQUE en celular
            await pool.query(`
                ALTER TABLE conversaciones_whatsapp
                ADD CONSTRAINT conversaciones_whatsapp_celular_unique UNIQUE (celular)
            `);

            console.log('✅ Constraint UNIQUE creado en celular');
        } else {
            console.log(`✅ Constraint UNIQUE existe: ${constraintCheck.rows[0].constraint_name}`);
        }

        return true;
    } catch (error) {
        console.error('❌ Error verificando tabla:', error.message);
        throw error;
    }
}

/**
 * Obtener lote de registros de Wix con reintentos
 */
async function fetchBatchFromWix(skip, limit, maxRetries = 5) {
    const url = `${WIX_BASE_URL}/exportarWHP?skip=${skip}&limit=${limit}`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 min timeout

            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                },
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Error desconocido de Wix');
            }

            return data;
        } catch (error) {
            console.error(`❌ Error fetching skip=${skip} (intento ${attempt}/${maxRetries}):`, error.message);

            if (attempt < maxRetries) {
                const waitTime = Math.min(attempt * 5000, 30000); // 5s, 10s, 15s, 20s, 25s, max 30s
                console.log(`⏳ Esperando ${waitTime/1000}s antes de reintentar...`);
                await new Promise(r => setTimeout(r, waitTime));
            } else {
                throw error;
            }
        }
    }
}

/**
 * Truncar string a longitud máxima
 */
function truncate(str, maxLen) {
    if (!str) return null;
    return str.length > maxLen ? str.substring(0, maxLen) : str;
}

/**
 * Mapear campos de Wix WHP a PostgreSQL conversaciones_whatsapp
 */
function mapWixToPostgres(item) {
    return {
        wix_whp_id: item._id || null,
        celular: truncate(item.userId, 20) || 'DESCONOCIDO',
        nombre_paciente: truncate(item.nombre, 255) || null,
        stopBot: item.stopBot === true,
        estado: 'migrada', // Marcar como migrada
        canal: 'bot',
        bot_activo: item.stopBot !== true, // Si stopBot es true, bot_activo es false
        fecha_inicio: item._createdDate ? new Date(item._createdDate) : new Date(),
        fecha_ultima_actividad: item._updatedDate ? new Date(item._updatedDate) : new Date()
    };
}

// Query de UPSERT preparada (sin created_at, updated_at, origen - columnas que no existen)
const UPSERT_QUERY = `
    INSERT INTO conversaciones_whatsapp (
        wix_whp_id, celular, nombre_paciente, "stopBot", estado, canal,
        bot_activo, fecha_inicio, fecha_ultima_actividad
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (celular) DO UPDATE SET
        wix_whp_id = COALESCE(EXCLUDED.wix_whp_id, conversaciones_whatsapp.wix_whp_id),
        nombre_paciente = COALESCE(EXCLUDED.nombre_paciente, conversaciones_whatsapp.nombre_paciente),
        "stopBot" = EXCLUDED."stopBot",
        bot_activo = EXCLUDED.bot_activo,
        fecha_ultima_actividad = EXCLUDED.fecha_ultima_actividad
`;

/**
 * Insertar un registro individual
 */
async function insertSingleRecord(item) {
    const mapped = mapWixToPostgres(item);
    const values = [
        mapped.wix_whp_id,
        mapped.celular,
        mapped.nombre_paciente,
        mapped.stopBot,
        mapped.estado,
        mapped.canal,
        mapped.bot_activo,
        mapped.fecha_inicio,
        mapped.fecha_ultima_actividad
    ];

    if (!dryRun) {
        const result = await pool.query(UPSERT_QUERY, values);
        // result.rowCount indica si fue INSERT (1) o UPDATE (1) o skip (0)
        return result;
    }
    return { rowCount: 1 }; // dry-run simula inserción
}

/**
 * Insertar lote de registros en PostgreSQL con procesamiento paralelo controlado
 */
async function insertBatchToPostgres(items) {
    if (items.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

    let inserted = 0;
    const PARALLEL_LIMIT = 10; // Procesar 10 registros en paralelo

    // Procesar en grupos de PARALLEL_LIMIT
    for (let i = 0; i < items.length; i += PARALLEL_LIMIT) {
        const batch = items.slice(i, i + PARALLEL_LIMIT);

        const results = await Promise.allSettled(
            batch.map(item => insertSingleRecord(item))
        );

        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled') {
                inserted++;
            } else {
                stats.errors.push({
                    userId: batch[j].userId,
                    error: results[j].reason?.message || 'Unknown error'
                });
                stats.totalErrors++;
            }
        }
    }

    return { inserted, updated: 0, skipped: 0 };
}

/**
 * Función principal de migración
 */
async function runMigration() {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('   MIGRACIÓN: WHP de Wix a PostgreSQL conversaciones_whatsapp');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`⏰ Inicio: ${new Date().toISOString()}`);
    console.log(`🔧 Modo: ${dryRun ? 'DRY-RUN (sin cambios reales)' : 'PRODUCCIÓN'}`);
    if (testMode) console.log(`🧪 MODO TEST: Solo primeros ${maxRecords} registros`);
    if (skipStart > 0) console.log(`⏩ Continuando desde registro: ${skipStart}`);
    console.log('');

    stats.startTime = new Date();

    try {
        // 1. Crear/verificar tabla
        await verificarTablaConversaciones();

        // 2. Obtener total de registros en Wix
        console.log('\n📡 Conectando a Wix...');
        const firstBatch = await fetchBatchFromWix(0, 1);
        const totalWix = firstBatch.totalCount;
        console.log(`📊 Total de registros en Wix WHP: ${totalWix.toLocaleString()}`);

        // 3. Calcular lotes
        const recordsToProcess = Math.min(totalWix - skipStart, maxRecords);
        const totalBatches = Math.ceil(recordsToProcess / BATCH_SIZE);
        console.log(`📦 Lotes a procesar: ${totalBatches} (de ${BATCH_SIZE} registros cada uno)`);
        if (maxRecords < Infinity) console.log(`🎯 Límite de registros: ${maxRecords}`);
        console.log('');

        // 4. Procesar lotes
        let currentSkip = skipStart;
        let batchNumber = 1;
        let hasMore = true;

        while (hasMore && stats.totalFetched < maxRecords) {
            const progress = ((currentSkip / totalWix) * 100).toFixed(1);
            process.stdout.write(`\r🔄 Procesando lote ${batchNumber}/${totalBatches} (${progress}% - skip=${currentSkip})...`);

            // Fetch batch
            const batch = await fetchBatchFromWix(currentSkip, BATCH_SIZE);
            stats.totalFetched += batch.items.length;

            // Insert batch
            const insertResult = await insertBatchToPostgres(batch.items);
            stats.totalInserted += insertResult.inserted;
            stats.totalUpdated += insertResult.updated;
            stats.totalSkipped += insertResult.skipped;

            // Update cursor
            hasMore = batch.hasMore;
            currentSkip = batch.nextSkip || (currentSkip + BATCH_SIZE);
            batchNumber++;

            // Pausa entre lotes
            if (hasMore && DELAY_BETWEEN_BATCHES_MS > 0) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
            }
        }

        console.log('\n');
        stats.endTime = new Date();

        // 5. Resumen final
        const durationMs = stats.endTime - stats.startTime;
        const durationMin = (durationMs / 60000).toFixed(2);

        console.log('═══════════════════════════════════════════════════════════════════');
        console.log('   RESUMEN DE MIGRACIÓN');
        console.log('═══════════════════════════════════════════════════════════════════');
        console.log(`✅ Registros obtenidos de Wix:        ${stats.totalFetched.toLocaleString()}`);
        console.log(`✅ Registros insertados/actualizados: ${stats.totalInserted.toLocaleString()}`);
        console.log(`⏭️  Registros omitidos:               ${stats.totalSkipped.toLocaleString()}`);
        console.log(`❌ Errores:                           ${stats.totalErrors.toLocaleString()}`);
        console.log(`⏱️  Duración total:                    ${durationMin} minutos`);
        console.log('');

        // Verificar conteo final en PostgreSQL
        const finalCount = await pool.query('SELECT COUNT(*) FROM conversaciones_whatsapp');
        console.log(`📊 Total registros en PostgreSQL: ${finalCount.rows[0].count}`);

        // Verificar registros con stopBot=true
        const stopBotCount = await pool.query('SELECT COUNT(*) FROM conversaciones_whatsapp WHERE "stopBot" = true');
        console.log(`🛑 Registros con stopBot=true: ${stopBotCount.rows[0].count}`);

        // Mostrar errores si los hay
        if (stats.errors.length > 0) {
            console.log('\n⚠️ Errores encontrados (primeros 10):');
            stats.errors.slice(0, 10).forEach(e => {
                console.log(`   - Usuario: ${e.userId}: ${e.error}`);
            });
            if (stats.errors.length > 10) {
                console.log(`   ... y ${stats.errors.length - 10} errores más`);
            }
        }

    } catch (error) {
        console.error('\n❌ Error fatal:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

/**
 * Verificar migración
 */
async function verifyMigration() {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('   VERIFICACIÓN DE MIGRACIÓN');
    console.log('═══════════════════════════════════════════════════════════════════');

    try {
        // Conteo en Wix
        console.log('\n📡 Consultando Wix...');
        const wixData = await fetchBatchFromWix(0, 1);
        console.log(`📊 Total en Wix WHP: ${wixData.totalCount.toLocaleString()}`);

        // Conteo en PostgreSQL
        const pgCount = await pool.query('SELECT COUNT(*) FROM conversaciones_whatsapp');
        console.log(`📊 Total en PostgreSQL: ${pgCount.rows[0].count}`);

        // Conteo con stopBot=true
        const stopBotCount = await pool.query('SELECT COUNT(*) FROM conversaciones_whatsapp WHERE "stopBot" = true');
        console.log(`🛑 Registros con stopBot=true: ${stopBotCount.rows[0].count}`);

        // Comparar
        const diff = wixData.totalCount - parseInt(pgCount.rows[0].count, 10);
        if (diff === 0) {
            console.log('\n✅ Los conteos coinciden. Migración completa.');
        } else if (diff > 0) {
            console.log(`\n⚠️ Faltan ${diff} registros en PostgreSQL.`);
            console.log('   Ejecuta: node migracion-whp.js');
        } else {
            console.log(`\n⚠️ PostgreSQL tiene ${Math.abs(diff)} registros más que Wix.`);
            console.log('   Esto puede ser normal si hay registros creados localmente.');
        }

        // Muestra de datos
        console.log('\n📋 Muestra de últimos 10 registros en PostgreSQL:');
        const sample = await pool.query(`
            SELECT celular, nombre_paciente, "stopBot", estado, fecha_inicio
            FROM conversaciones_whatsapp
            ORDER BY fecha_ultima_actividad DESC
            LIMIT 10
        `);
        sample.rows.forEach((row, i) => {
            const stopBotIcon = row.stopBot ? '🛑' : '✅';
            console.log(`   ${i + 1}. ${row.celular} - ${row.nombre_paciente || 'Sin nombre'} ${stopBotIcon} (${row.estado})`);
        });

    } catch (error) {
        console.error('❌ Error en verificación:', error.message);
    } finally {
        await pool.end();
    }
}

// Ejecutar
if (verifyOnly) {
    verifyMigration();
} else {
    runMigration();
}
