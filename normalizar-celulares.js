/**
 * Script para Normalizar Formato de Celulares en PostgreSQL
 *
 * Este script agrega el prefijo 57 a los celulares colombianos que no lo tienen.
 *
 * Uso:
 *   node normalizar-celulares.js [--dry-run]
 *
 * Opciones:
 *   --dry-run     Solo mostrar lo que se haría, sin hacer cambios
 *
 * Reglas de normalización:
 *   - Si empieza con 3 y tiene 10 dígitos → Agregar prefijo 57
 *   - Si ya tiene prefijo 57 → No modificar
 *   - Si es número internacional (no Colombia) → No modificar
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

// Argumentos de línea de comandos
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// Estadísticas
const stats = {
    totalAnalizados: 0,
    totalNormalizados: 0,
    totalOmitidos: 0,
    totalErrores: 0,
    startTime: null,
    endTime: null,
    errores: []
};

/**
 * Determinar si un celular necesita normalización
 * @param {string} celular - Número de celular
 * @returns {Object} - { necesitaNormalizacion, nuevoValor, razon }
 */
function analizarCelular(celular) {
    if (!celular) {
        return { necesitaNormalizacion: false, nuevoValor: null, razon: 'Celular vacío o null' };
    }

    const celularStr = String(celular).trim();

    // Ya tiene prefijo 57 colombiano
    if (celularStr.startsWith('57') && celularStr.length === 12) {
        return { necesitaNormalizacion: false, nuevoValor: null, razon: 'Ya tiene prefijo 57' };
    }

    // Celular colombiano sin prefijo (empieza con 3 y tiene 10 dígitos)
    if (celularStr.startsWith('3') && celularStr.length === 10 && /^\d+$/.test(celularStr)) {
        return {
            necesitaNormalizacion: true,
            nuevoValor: '57' + celularStr,
            razon: 'Celular colombiano sin prefijo'
        };
    }

    // Números internacionales (no Colombia) - no modificar
    if (/^\d+$/.test(celularStr) && (celularStr.startsWith('1') || celularStr.startsWith('56'))) {
        return { necesitaNormalizacion: false, nuevoValor: null, razon: 'Número internacional (no Colombia)' };
    }

    // Formato desconocido o inválido - no modificar
    return { necesitaNormalizacion: false, nuevoValor: null, razon: 'Formato no reconocido' };
}

/**
 * Normalizar un celular en la base de datos
 */
async function normalizarCelular(id, celularActual, celularNuevo) {
    try {
        if (!dryRun) {
            await pool.query(`
                UPDATE conversaciones_whatsapp
                SET celular = $1,
                    fecha_ultima_actividad = NOW()
                WHERE id = $2
            `, [celularNuevo, id]);
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Función principal
 */
async function runNormalization() {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('   NORMALIZACIÓN DE CELULARES EN PostgreSQL');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`⏰ Inicio: ${new Date().toISOString()}`);
    console.log(`🔧 Modo: ${dryRun ? 'DRY-RUN (sin cambios reales)' : 'PRODUCCIÓN'}`);
    console.log('');

    stats.startTime = new Date();

    try {
        // 1. Obtener todos los celulares que NO tienen prefijo 57
        console.log('📊 Buscando celulares sin prefijo 57...');
        const result = await pool.query(`
            SELECT id, celular, nombre_paciente, estado
            FROM conversaciones_whatsapp
            WHERE celular NOT LIKE '57%'
            ORDER BY id
        `);

        const celularesSinPrefijo = result.rows;
        console.log(`📋 Encontrados ${celularesSinPrefijo.length} registros sin prefijo 57\n`);

        if (celularesSinPrefijo.length === 0) {
            console.log('✅ No hay registros que normalizar');
            return;
        }

        // 2. Analizar cada celular
        console.log('🔍 Analizando celulares...\n');
        const normalizaciones = [];

        for (const registro of celularesSinPrefijo) {
            stats.totalAnalizados++;
            const analisis = analizarCelular(registro.celular);

            if (analisis.necesitaNormalizacion) {
                normalizaciones.push({
                    id: registro.id,
                    celularActual: registro.celular,
                    celularNuevo: analisis.nuevoValor,
                    nombre: registro.nombre_paciente,
                    estado: registro.estado
                });
            } else {
                stats.totalOmitidos++;
                if (dryRun) {
                    console.log(`⏭️  OMITIR: ${registro.celular} → ${analisis.razon}`);
                }
            }
        }

        console.log(`\n📊 Análisis completado:`);
        console.log(`   - Total analizados: ${stats.totalAnalizados}`);
        console.log(`   - Requieren normalización: ${normalizaciones.length}`);
        console.log(`   - Se omiten: ${stats.totalOmitidos}\n`);

        if (normalizaciones.length === 0) {
            console.log('✅ No hay celulares que normalizar');
            return;
        }

        // 3. Mostrar vista previa de cambios
        console.log('═══════════════════════════════════════════════════════════════════');
        console.log('   VISTA PREVIA DE CAMBIOS');
        console.log('═══════════════════════════════════════════════════════════════════\n');

        normalizaciones.slice(0, 20).forEach((n, i) => {
            console.log(`${i + 1}. ${n.celularActual} → ${n.celularNuevo}`);
            console.log(`   Nombre: ${n.nombre || 'Sin nombre'} | Estado: ${n.estado}`);
        });

        if (normalizaciones.length > 20) {
            console.log(`\n... y ${normalizaciones.length - 20} registros más\n`);
        }

        console.log('');

        // 4. Aplicar normalizaciones
        if (dryRun) {
            console.log('🔍 DRY-RUN: No se realizarán cambios reales');
            stats.totalNormalizados = normalizaciones.length;
        } else {
            console.log('💾 Aplicando normalizaciones...\n');

            for (let i = 0; i < normalizaciones.length; i++) {
                const n = normalizaciones[i];
                const resultado = await normalizarCelular(n.id, n.celularActual, n.celularNuevo);

                if (resultado.success) {
                    stats.totalNormalizados++;
                    if ((i + 1) % 50 === 0) {
                        process.stdout.write(`\r✅ Normalizados: ${stats.totalNormalizados}/${normalizaciones.length}`);
                    }
                } else {
                    stats.totalErrores++;
                    stats.errores.push({
                        celular: n.celularActual,
                        error: resultado.error
                    });
                }
            }

            console.log(`\n\n✅ Normalización completada`);
        }

        stats.endTime = new Date();

        // 5. Resumen final
        const durationMs = stats.endTime - stats.startTime;
        const durationSec = (durationMs / 1000).toFixed(2);

        console.log('\n═══════════════════════════════════════════════════════════════════');
        console.log('   RESUMEN FINAL');
        console.log('═══════════════════════════════════════════════════════════════════');
        console.log(`✅ Celulares analizados:     ${stats.totalAnalizados}`);
        console.log(`✅ Celulares normalizados:   ${stats.totalNormalizados}`);
        console.log(`⏭️  Celulares omitidos:       ${stats.totalOmitidos}`);
        console.log(`❌ Errores:                  ${stats.totalErrores}`);
        console.log(`⏱️  Duración:                 ${durationSec} segundos`);

        if (stats.totalErrores > 0) {
            console.log('\n⚠️ Errores encontrados (primeros 5):');
            stats.errores.slice(0, 5).forEach(e => {
                console.log(`   - ${e.celular}: ${e.error}`);
            });
        }

        // 6. Verificación post-normalización
        if (!dryRun && stats.totalNormalizados > 0) {
            console.log('\n📊 Verificación post-normalización:');
            const verificacion = await pool.query(`
                SELECT COUNT(*) as total,
                       SUM(CASE WHEN celular LIKE '57%' THEN 1 ELSE 0 END) as con_prefijo,
                       SUM(CASE WHEN celular NOT LIKE '57%' THEN 1 ELSE 0 END) as sin_prefijo
                FROM conversaciones_whatsapp
            `);

            const v = verificacion.rows[0];
            console.log(`   Total registros: ${v.total}`);
            console.log(`   Con prefijo 57: ${v.con_prefijo} (${((v.con_prefijo / v.total) * 100).toFixed(1)}%)`);
            console.log(`   Sin prefijo 57: ${v.sin_prefijo} (${((v.sin_prefijo / v.total) * 100).toFixed(1)}%)`);
        }

        console.log('\n═══════════════════════════════════════════════════════════════════\n');

    } catch (error) {
        console.error('\n❌ Error fatal:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Ejecutar
runNormalization();
