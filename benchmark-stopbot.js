/**
 * Benchmark: Comparación de Rendimiento stopBot
 *
 * Compara la velocidad de:
 * - Método actual: getConversationFromDB() (incluye HTTP a Wix)
 * - Método optimizado: checkStopBot() (solo PostgreSQL)
 *
 * Uso:
 *   node benchmark-stopbot.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false }
});

const WIX_BACKEND_URL = 'https://www.bsl.com.co/_functions';

// ═══════════════════════════════════════════════════════════════════════════
// FUNCIONES A COMPARAR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MÉTODO ACTUAL: Query completo + HTTP a Wix
 */
async function getOrCreateConversationPostgres(celular) {
  try {
    let result = await pool.query(`
      SELECT id, celular, nombre_paciente, estado, bot_activo, "stopBot",
             wix_whp_id, fecha_ultima_actividad
      FROM conversaciones_whatsapp
      WHERE celular = $1 AND estado != 'cerrada'
      ORDER BY fecha_ultima_actividad DESC
      LIMIT 1
    `, [celular]);

    if (result.rows.length > 0) {
      await pool.query(`
        UPDATE conversaciones_whatsapp
        SET fecha_ultima_actividad = NOW()
        WHERE id = $1
      `, [result.rows[0].id]);

      return result.rows[0];
    }

    result = await pool.query(`
      INSERT INTO conversaciones_whatsapp (
        celular, estado, canal, bot_activo, "stopBot",
        fecha_inicio, fecha_ultima_actividad
      ) VALUES ($1, 'nueva', 'bot', true, false, NOW(), NOW())
      RETURNING id, celular, nombre_paciente, estado, bot_activo, "stopBot", wix_whp_id
    `, [celular]);

    return result.rows[0];
  } catch (error) {
    return {
      id: null,
      celular,
      stopBot: false
    };
  }
}

async function getConversationFromDB_Original(userId) {
  const pgConv = await getOrCreateConversationPostgres(userId);

  try {
    const response = await axios.get(`${WIX_BACKEND_URL}/obtenerConversacion`, {
      params: { userId }
    });

    if (response.data) {
      const stopBotFinal = pgConv.stopBot !== undefined ? pgConv.stopBot : (response.data.stopBot === true);

      return {
        stopBot: stopBotFinal,
        mensajes: response.data.mensajes || [],
        observaciones: response.data.observaciones || '',
        threadId: response.data.threadId || '',
        pgConvId: pgConv.id
      };
    }

    return {
      stopBot: pgConv.stopBot || false,
      mensajes: [],
      observaciones: '',
      threadId: '',
      pgConvId: pgConv.id
    };
  } catch (error) {
    return {
      stopBot: pgConv.stopBot || false,
      mensajes: [],
      observaciones: '',
      threadId: '',
      pgConvId: pgConv.id
    };
  }
}

/**
 * MÉTODO OPTIMIZADO: Solo SELECT de stopBot
 */
async function checkStopBot_Optimizado(celular) {
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

    return false;
  } catch (error) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BENCHMARK
// ═══════════════════════════════════════════════════════════════════════════

async function benchmark() {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('   BENCHMARK: Comparación de Rendimiento stopBot');
    console.log('═══════════════════════════════════════════════════════════════════\n');

    try {
        // 1. Obtener celulares de prueba
        console.log('📊 Obteniendo celulares de prueba...');
        const testUsers = await pool.query(`
            SELECT celular, "stopBot"
            FROM conversaciones_whatsapp
            WHERE estado != 'cerrada'
            ORDER BY fecha_ultima_actividad DESC
            LIMIT 10
        `);

        if (testUsers.rows.length === 0) {
            console.log('❌ No hay usuarios para testear');
            return;
        }

        console.log(`✅ ${testUsers.rows.length} usuarios para testear\n`);

        const celulares = testUsers.rows.map(u => u.celular);

        // 2. Benchmark del método ORIGINAL
        console.log('═══════════════════════════════════════════════════════════════════');
        console.log('   MÉTODO ORIGINAL: getConversationFromDB() + HTTP Wix');
        console.log('═══════════════════════════════════════════════════════════════════\n');

        const tiemposOriginal = [];
        for (let i = 0; i < celulares.length; i++) {
            const celular = celulares[i];
            const inicio = Date.now();

            const result = await getConversationFromDB_Original(celular);

            const duracion = Date.now() - inicio;
            tiemposOriginal.push(duracion);

            console.log(`${i + 1}. ${celular}: ${duracion}ms (stopBot=${result.stopBot})`);
        }

        const promedioOriginal = tiemposOriginal.reduce((a, b) => a + b, 0) / tiemposOriginal.length;
        const minOriginal = Math.min(...tiemposOriginal);
        const maxOriginal = Math.max(...tiemposOriginal);

        console.log(`\n📊 Estadísticas:`);
        console.log(`   - Promedio: ${promedioOriginal.toFixed(2)}ms`);
        console.log(`   - Mínimo: ${minOriginal}ms`);
        console.log(`   - Máximo: ${maxOriginal}ms`);

        // 3. Benchmark del método OPTIMIZADO
        console.log('\n═══════════════════════════════════════════════════════════════════');
        console.log('   MÉTODO OPTIMIZADO: checkStopBot() (solo PostgreSQL)');
        console.log('═══════════════════════════════════════════════════════════════════\n');

        const tiemposOptimizado = [];
        for (let i = 0; i < celulares.length; i++) {
            const celular = celulares[i];
            const inicio = Date.now();

            const result = await checkStopBot_Optimizado(celular);

            const duracion = Date.now() - inicio;
            tiemposOptimizado.push(duracion);

            console.log(`${i + 1}. ${celular}: ${duracion}ms (stopBot=${result})`);
        }

        const promedioOptimizado = tiemposOptimizado.reduce((a, b) => a + b, 0) / tiemposOptimizado.length;
        const minOptimizado = Math.min(...tiemposOptimizado);
        const maxOptimizado = Math.max(...tiemposOptimizado);

        console.log(`\n📊 Estadísticas:`);
        console.log(`   - Promedio: ${promedioOptimizado.toFixed(2)}ms`);
        console.log(`   - Mínimo: ${minOptimizado}ms`);
        console.log(`   - Máximo: ${maxOptimizado}ms`);

        // 4. Comparación
        console.log('\n═══════════════════════════════════════════════════════════════════');
        console.log('   COMPARACIÓN Y MEJORA');
        console.log('═══════════════════════════════════════════════════════════════════\n');

        const mejoraPorcentaje = ((promedioOriginal - promedioOptimizado) / promedioOriginal * 100);
        const factorMejora = (promedioOriginal / promedioOptimizado);

        console.log('📊 Resumen:');
        console.log(`   Método Original:    ${promedioOriginal.toFixed(2)}ms`);
        console.log(`   Método Optimizado:  ${promedioOptimizado.toFixed(2)}ms`);
        console.log(`   Mejora:             ${mejoraPorcentaje.toFixed(1)}% más rápido`);
        console.log(`   Factor:             ${factorMejora.toFixed(1)}x más rápido`);
        console.log(`   Reducción absoluta: ${(promedioOriginal - promedioOptimizado).toFixed(2)}ms`);

        console.log('\n✅ Conclusión:');
        if (mejoraPorcentaje > 50) {
            console.log(`   ✅ EXCELENTE - Mejora significativa del ${mejoraPorcentaje.toFixed(1)}%`);
        } else if (mejoraPorcentaje > 20) {
            console.log(`   ✅ BUENO - Mejora notable del ${mejoraPorcentaje.toFixed(1)}%`);
        } else {
            console.log(`   ⚠️ MODERADO - Mejora del ${mejoraPorcentaje.toFixed(1)}%`);
        }

        console.log('\n═══════════════════════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('❌ Error en benchmark:', error.message);
        console.error(error.stack);
    } finally {
        await pool.end();
    }
}

// Ejecutar
benchmark();
